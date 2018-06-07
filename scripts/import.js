const MongoClient = require("mongodb").MongoClient;
const crypto = require("crypto");

const {
    objectIdFromDate
} = require("../classes/utilities.js");

function usage() {
    console.log(
        `Usage:
    -n [default=10],        # of best networks
    -g [default=10000]      # of self play games
    -m [default=100]        # of matches
`);
}
function getRandomInt(max) {
    return Math.floor(Math.random() * Math.floor(max));
}

process.argv.shift(); // node
process.argv.shift(); // import.js

const options = {
    n: 10,
    g: 10000,
    m: 100
};
let help = false;

for (let i = 0; i < process.argv.length; i++) {
    switch (process.argv[i]) {
        case "-n":
            options.n = +process.argv[++i] || options.n;
            break;
        case "-g":
            options.g = +process.argv[++i] || options.g;
            break;
        case "-m":
            options.m = +process.argv[++i] || options.m;
            break;
        case "-h":
            usage();
            help = true;
            break;
    }
}

if (!help) {
    MongoClient.connect("mongodb://localhost/test", async(err, db) => {
        console.log(`Importing ${options.n} networks, ${options.g} self play games and ${options.m} matches.`);

        // Network
        const networks = [];
        const filters_step = [64, 128, 192, 256];
        const blocks_step = [10, 15, 20, 25, 30, 35, 40];
        for (let i = 0; i < options.n; i++) {
            networks.push({
                hash: crypto.randomBytes(32).toString("hex"),
                filters: filters_step[Math.floor(i / options.n * filters_step.length)],
                blocks: blocks_step[Math.floor(i / options.n * blocks_step.length)],
                training_count: 100000 * i,
                training_steps: 32000 * (i % 8 + 1),
                game_count: Math.floor(options.g / options.n)
            });
        }
        await db.collection("networks").insertMany(networks);

        // Self play games
        let games = [];
        for (let i = 0; i < options.g; i++) {
            games.push({
                ip: "127.0.0.1",
                networkhash: networks[Math.floor(i / options.g * options.n)].hash,
                sgf: crypto.randomBytes(16).toString("hex"),
                sgfhash: crypto.randomBytes(16).toString("hex"),
                options_hash: crypto.randomBytes(2).toString("hex"),
                movescount: getRandomInt(722),
                data: crypto.randomBytes(16).toString("hex"),
                clientversion: getRandomInt(16),
                winnercolor: ["W", "B"][getRandomInt(2)],
                random_seed: parseInt(crypto.randomBytes(7).toString("hex"), 16)
            });

            if (games.length == 10000) {
                // batch insert every 10000 games
                await db.collection("games").insertMany(games);
                games = [];
            }
        }

        // insert last batch
        if (games.length) {
            await db.collection("games").insertMany(games);
        }

        const first_match = {};
        // Matches
        for (let i = 0; i < options.m; i++) {
            const network_idx = Math.floor(i / options.m * options.n);
            const match = {
                number_to_play: 400,
                options: {},
                options_hash: crypto.randomBytes(2).toString("hex")
            };

            // first match
            if (network_idx > 0 && !first_match[network_idx]) {
                match.network1 = networks[network_idx].hash;
                match.network2 = networks[network_idx - 1].hash;
                match.network1_losses = 180;
                match.network1_wins = 220;
                match.game_count = 400;
                first_match[network_idx] = true;
            } else {
                match.network1 = crypto.randomBytes(32).toString("hex");
                match.network2 = networks[network_idx].hash;
                match.network1_losses = 220;
                match.network1_wins = 180;
                match.game_count = 400;

                await db.collection("networks").insertOne({
                    hash: match.network1,
                    filters: filters_step[Math.floor(i / options.n * filters_step.length)],
                    blocks: blocks_step[Math.floor(i / options.n * blocks_step.length)],
                    training_count: 100000 * i,
                    training_steps: 32000 * (i % 8 + 1)
                });
            }

            await db.collection("matches").insertOne(match);
        }

        // Access logs
        await db.collection("logs").removeMany();
        for (let i = 0; i < 24 * 60; i++) {
            await db.collection("logs").insertOne({
                _id: objectIdFromDate(Date.now() - 1000 * i * 60),
                method: "GET",
                url: "/test",
                status: 200,
                "response-time": i * 0.5
            });
        }

        db.close();
    });

    // Network
}
