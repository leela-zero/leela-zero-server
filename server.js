require("./classes/prototypes.js");
const moment = require("moment");
const express = require("express");
const fileUpload = require("express-fileupload");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const fs = require("fs-extra");
const MongoClient = require("mongodb").MongoClient;
const Long = require("mongodb").Long;
const ObjectId = require("mongodb").ObjectID;
const zlib = require("zlib");
const Cacheman = require("cacheman");
const app = express();
const Busboy = require("busboy");
const weight_parser = require("./classes/weight_parser.js");
const rss_generator = require("./classes/rss_generator.js");
const os = require("os");
const path = require("path");
const discord = require("./classes/discord");
const morgan = require("morgan");
const rfs = require("rotating-file-stream");
const dbutils = require("./classes/dbutils");
const mongoMorgan = require("mongo-morgan");
const Raven = require("raven");
const config = require("./config");

const MONGODB_URL = "mongodb://localhost/test";

if (config.RAVEN_DSN) {
    console.log("init raven");
    Raven.config(config.RAVEN_DSN, { captureUnhandledRejections: true }).install();
}

/**
 * Request Logging
 */
const logDir = path.join(__dirname, "logs");
fs.ensureDirSync(logDir);
const logStream = rfs("access.log", {
    interval: "1d", // rotate daily
    maxFiles: 7, // keep 1 week worth of logs
    path: logDir
});
morgan.token("memory", () => {
    const used = process.memoryUsage();
    const usage = [];

    for (const key in used) {
        const size = (used[key] / 1024 / 1024).toFixed(2);

        usage.push(`${key}: ${size} MB`);
    }

    return usage.join(", ");
});
mongoMorgan.token("epochtime", () => Date.now());

// Save access log to `logs` collection
app.use(
    mongoMorgan(
        MONGODB_URL,
        "{\"method\": \":method\", \"url\": \":url\", \"status\": :status, \"response-time\": :response-time, \"time\": :epochtime}",
        { collection: "logs" })
    );

app.use(morgan("-->Before :memory", { stream: logStream, immediate: true }));
app.use(morgan(":method :url :status :req[content-length] :response-time ms", { stream: logStream, immediate: false }));
app.use(morgan("-->After  :memory", { stream: logStream, immediate: false }));

/**
 * Utilities
 */
const {
    set_task_verification_secret,
    add_match_verification,
    check_match_verification,
    network_exists,
    checksum,
    make_seed,
    get_timestamp_from_seed,
    seed_from_mongolong,
    process_games_list,
    CalculateEloFromPercent,
    objectIdFromDate,
    log_memory_stats,
    SPRT,
    LLR,
    asyncMiddleware,
    how_many_games_to_queue,
    add_gzip_hash
} = require("./classes/utilities.js");

const ELF_NETWORKS = [
    "62b5417b64c46976795d10a6741801f15f857e5029681a42d02c9852097df4b9",
    "d13c40993740cb77d85c838b82c08cc9c3f0fbc7d8c3761366e5d59e8f371cbd"
];

const auth_key = String(fs.readFileSync(__dirname + "/auth_key")).trim();
set_task_verification_secret(String(fs.readFileSync(__dirname + "/task_secret")).trim());

const cacheIP24hr = new Cacheman("IP24hr");
const cacheIP1hr = new Cacheman("IP1hr");

// Cache information about matches and best network rating
const cachematches = new Cacheman("matches");
let bestRatings = new Map();

const fastClientsMap = new Map();

app.set("view engine", "pug");

// This shouldn't be needed but now and then when I restart test server, I see an uncaught ECONNRESET and I'm not sure
// where it is coming from. In case a server restart did the same thing, this should prevent a crash that would stop nodemon.
//
// It was a bug in nodemon which has now been fixed. It is bad practice to leave this here, eventually remove it.
//
process.on("uncaughtException", err => {
    console.error("Caught exception: " + err);
});

// https://blog.tompawlak.org/measure-execution-time-nodejs-javascript

let counter = 0;
let elf_counter = 0;
let best_network_mtimeMs = 0;
let best_network_hash_promise = null;
let db;

// TODO Make a map to store pending match info, use mapReduce to find who to serve out, only
// delete when SPRT fail or needed games have all arrived? Then we can update stats easily on
// all matches except just the current one (end of queue).
//
let pending_matches = [];
const MATCH_EXPIRE_TIME = 30 * 60 * 1000; // matches expire after 30 minutes. After that the match will be lost and an extra request will be made.

function get_options_hash(options) {
    if (options.visits) {
        return checksum("" + options.visits + options.resignation_percent + options.noise + options.randomcnt).slice(0, 6);
    } else {
        return checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0, 6);
    }
}

async function get_fast_clients() {
    const start = Date.now();
    try {
        // Get some recent self-play games to calculate durations from seeds
        const games = await db.collection("games").find({}, { ip: 1, movescount: 1, random_seed: 1 })
            .sort({ _id: -1 }).limit(1000).toArray();

        // Keep track of the move rate of each game by client
        fastClientsMap.clear();
        games.forEach(game => {
            const seed = (s => s instanceof Long ? s : new Long(s))(game.random_seed);
            const startTime = get_timestamp_from_seed(seed);
            const minutes = (game._id.getTimestamp() / 1000 - startTime) / 60;

            // Make sure we have some reasonable duration
            if (minutes > 0 && minutes <= 60 * 24)
                fastClientsMap.set(game.ip, [...(fastClientsMap.get(game.ip) || []), game.movescount / minutes]);
        });

        // Clean up the map to be a single rate value with enough entries
        for (const [ip, rates] of fastClientsMap) {
            // Remove clients that submitted only a couple fast games (in case
            // some unexpected seed just happens to match the duration)
            if (rates.length < 3)
                fastClientsMap.delete(ip);
            else
                fastClientsMap.set(ip, rates.reduce((t, v) => t + v) / rates.length);
        }

        // Short circuit if there's nothing interesting to do
        if (fastClientsMap.size == 0) {
            console.log("No clients found with sufficient rate data");
            return;
        }

        // Print out some statistics on rates
        const sortedRates = [...fastClientsMap.values()].sort((a, b) => a - b);
        const quartile = n => {
            const index = n / 4 * (sortedRates.length - 1);
            return index % 1 == 0 ? sortedRates[index] : (sortedRates[Math.floor(index)] + sortedRates[Math.ceil(index)]) / 2;
        };
        console.log("Client moves per minute rates:", ["min", "25%", "median", "75%", "max"].map((text, index) => `${quartile(index).toFixed(1)} ${text}`).join(", "));

        // Keep only clients that have the top 25% rates
        const top25Rate = quartile(2);
        for (const [ip, rate] of fastClientsMap) {
            if (rate < top25Rate)
                fastClientsMap.delete(ip);
        }

        console.log(`In ${Date.now() - start}ms from recent ${games.length} games, found ${fastClientsMap.size} fast clients:`, fastClientsMap);
    } catch (err) {
        console.log("Failed to get recent games for fast clients:", err);
    }
}

//  db.matches.aggregate( [ { "$redact": { "$cond": [ { "$gt": [ "$number_to_play", "$game_count" ] }, "$$KEEP", "$$PRUNE" ] } } ] )
//
async function get_pending_matches() {
    pending_matches = [];

    return new Promise((resolve, reject) => {
        db.collection("matches").aggregate([
            { $redact: { $cond:
                [
                    { $gt: [ "$number_to_play", "$game_count" ] },
                    "$$KEEP", "$$PRUNE"
                ] } }
        ]).sort({ _id: -1 }).forEach(match => {
            match.requests = []; // init request list.

            // Client only accepts strings for now
            //
            Object.keys(match.options).map(key => {
                match.options[key] = String(match.options[key]);
            });

            // If SPRT=pass use unshift() instead of push() so "Elo only" matches go last in priority
            //
            switch (SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    break;
                case true:
                    pending_matches.unshift(match);
                    console.log("SPRT: Unshifting: " + JSON.stringify(match));
                    break;
                default:
                    pending_matches.push(match);
                    console.log("SPRT: Pushing: " + JSON.stringify(match));
            }
        }, err => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });
        resolve();
    });
}

async function get_best_network_hash() {
    // Check if file has changed. If not, send cached version instead.
    //
    return fs.stat(__dirname + "/network/best-network.gz")
    .then(stats => {
        if (!best_network_hash_promise || best_network_mtimeMs != stats.mtimeMs) {
            best_network_mtimeMs = stats.mtimeMs;

            best_network_hash_promise = new Promise((resolve, reject) => {
                log_memory_stats("best_network_hash_promise begins");

                const rstream = fs.createReadStream(__dirname + "/network/best-network.gz");
                const gunzip = zlib.createGunzip();
                const hash = crypto.createHash("sha256");

                hash.setEncoding("hex");

                log_memory_stats("Streams prepared");

                rstream
                .pipe(gunzip)
                .pipe(hash)
                .on("error", err => {
                    console.error("Error opening/gunzip/hash best-network.gz: " + err);
                    reject(err);
                })
                .on("finish", () => {
                    const best_network_hash = hash.read();
                    log_memory_stats("Streams completed: " + best_network_hash);
                    resolve(best_network_hash);
                });
            });
        }

        return best_network_hash_promise;
    })
    .catch(err => console.error(err));
}

const PESSIMISTIC_RATE = 0.4;

app.enable("trust proxy");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(/\/((?!submit-network).)*/, fileUpload());

app.use("/view/player", express.static("static/eidogo-player-1.2/player"));
app.use("/viewmatch/player", express.static("static/eidogo-player-1.2/player"));
app.use("/view/wgo", express.static("static/wgo"));
app.use("/viewmatch/wgo", express.static("static/wgo"));
app.use("/static", express.static("static", { maxage: "365d", etag: true }));

// This is async but we don't need it to start the server. I'm calling it during startup so it'll get the value cached right away
// instead of when the first /best-network request comes in, in case a lot of those requests come in at once when server
// starts up.
get_best_network_hash().then(hash => console.log("Current best hash " + hash));

setInterval(() => {
    log_memory_stats("10 minute interval");

    get_fast_clients()
    .then()
    .catch();
}, 1000 * 60 * 10);

let last_match_db_check = Date.now();

setInterval(() => {
    const now = Date.now();

    // In case we have no matches scheduled, we check the db.
    //
    if (pending_matches.length === 0 && now > last_match_db_check + 30 * 60 * 1000) {
        console.log("No matches scheduled. Updating pending list.");

        last_match_db_check = now;

        get_pending_matches()
        .then()
        .catch();
    }
}, 1000 * 60 * 1);

MongoClient.connect(MONGODB_URL, (err, database) => {
    if (err) return console.log(err);

    db = database;

    db.collection("networks").count()
    .then(count => {
        console.log(count + " networks.");
    });

    db.collection("networks").aggregate([
        {
            $group: {
                _id: {
                    type: {
                        $cond: {
                            if: { $in: ["$hash", ELF_NETWORKS] },
                            then: "ELF",
                            else: "LZ"
                        }
                    }
                },
                total: { $sum: "$game_count" }
            }
        }
    ], (err, res) => {
        if (err) console.log(err);

        get_fast_clients()
        .then()
        .catch();

        get_pending_matches()
        .then()
        .catch();

        res.forEach(result => {
            if (result._id.type == "ELF")
                elf_counter = result.total;
            else
                counter = result.total;
        });
        console.log(counter + " LZ games, " + elf_counter + " ELF games.");

        app.listen(8080, () => {
            console.log("listening on 8080");
        });

        // Listening to both ports while /next people are moving over to real server adddress
        //
        // app.listen(8081, () => {
        //    console.log('listening on 8081')
        // });
    });
});

// Obsolete
//
app.use("/best-network-hash", asyncMiddleware(async(req, res) => {
    const hash = await get_best_network_hash();

    res.write(hash);
    res.write("\n");
    // Can remove if autogtp no longer reads this. Required client and leelza versions are in get-task now.
    res.write("11");
    res.end();
}));

// Server will copy a new best-network to the proper location if validation testing of an uploaded network shows
// it is stronger than the prior network. So we don't need to worry about locking the file/etc when uploading to
// avoid an accidential download of a partial upload.
//
// This is no longer used, as /network/ is served by nginx and best-network.gz downloaded directly from it
//
app.use("/best-network", asyncMiddleware(async(req, res) => {
    const hash = await get_best_network_hash();
    const readStream = fs.createReadStream(__dirname + "/network/best-network.gz");

    readStream.on("error", err => {
        res.send("Error: " + err);
        console.error("ERROR /best-network : " + err);
    });

    readStream.on("open", () => {
        res.setHeader("Content-Disposition", "attachment; filename=" + hash + ".gz");
        res.setHeader("Content-Transfer-Encoding", "binary");
        res.setHeader("Content-Type", "application/octet-stream");
    });

    readStream.pipe(res);

    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " downloaded /best-network");
}));

app.post("/request-match", (req, res) => {
    // "number_to_play" : 400, "options" : { "playouts" : 1600, "resignation_percent" : 1, "randomcnt" : 0, "noise" : "false" }

    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send("Incorrect key provided.");
    }

    if (!req.body.network1)
        return res.status(400).send("No network1 hash specified.");
    else if (!network_exists(req.body.network1))
        return res.status(400).send("network1 hash not found.");

    if (!req.body.network2)
        req.body.network2 = null;
    else if (!network_exists(req.body.network2))
        return res.status(400).send("network2 hash not found.");

    // TODO Need to support new --visits flag as an alternative to --playouts. Use visits if both are missing? Don't allow both to be set.
    //
    if (req.body.playouts && req.body.visits)
        return res.status(400).send("Please set only playouts or visits, not both");

    if (!req.body.playouts && !req.body.visits)
        //req.body.playouts = 1600;
        req.body.visits = 1600;
        //return res.status(400).send('No playouts specified.');

    if (!req.body.resignation_percent)
        req.body.resignation_percent = 5;
        //return res.status(400).send('No resignation_percent specified.');

    if (!req.body.noise)
        req.body.noise = false;
        //return res.status(400).send('No noise specified.');

    if (!req.body.randomcnt)
        req.body.randomcnt = 0;
        //return res.status(400).send('No randomcnt specified.');

    if (!req.body.number_to_play)
        req.body.number_to_play = 400;
        //return res.status(400).send('No number_to_play specified.');

    const options = { resignation_percent: Number(req.body.resignation_percent),
        randomcnt: Number(req.body.randomcnt),
        noise: String(req.body.noise) };

    if (req.body.playouts) {
        options.playouts = Number(req.body.playouts);
    }

    if (req.body.visits) {
        options.visits = Number(req.body.visits);
    }

    // Usage:
    //   - schedule a Test match, set is_test=true or is_test=1
    //   curl -F is_test=true <other params>
    //
    //   - schedule a Normal match, leave out the flag
    //   curl  <other params>
    //
    req.body.is_test = ["true", "1"].includes(req.body.is_test);

    const match = { network1: req.body.network1,
        network2: req.body.network2, network1_losses: 0,
        network1_wins: 0,
        game_count: 0, number_to_play: Number(req.body.number_to_play),
        is_test: req.body.is_test,
        options, options_hash: get_options_hash(options) };

    db.collection("matches").insertOne(match)
    .then(() => {
        // Update cache
        dbutils.clear_matches_cache();

        // Client only accepts strings for now
        Object.keys(match.options).map(key => {
            match.options[key] = String(match.options[key]);
        });

        match.requests = []; // init request list.
        pending_matches.unshift(match);

        console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " Match added!");
        res.send((match.is_test ? "Test" : "Regular") + " Match added!\n");
        console.log("Pending is now: " + JSON.stringify(pending_matches));
    })
    .catch(err => {
        console.error(req.ip + " (" + req.headers["x-real-ip"] + ") " + " ERROR: Match addition failed: " + err);
        res.send("ERROR: Match addition failed\n");
    });
});

// curl -F 'weights=@zero.prototxt' -F 'training_count=175000' http://localhost:8080/submit-network
//
// Detect if network already exists and if so, inform the uploader and don't overwrite?
// So we don't think the network is newer than it really is. Actually, upsert shouldn't change
// the ObjectID so date will remain original insertion date.
//
app.post("/submit-network", asyncMiddleware((req, res) => {
    log_memory_stats("submit network start");
    const busboy = new Busboy({ headers: req.headers });

    req.body = {};

    let file_promise = null;

    req.pipe(busboy).on("field", (name, value) => {
        req.body[name] = value;
    }).on("file", (name, file_stream, file_name) => {
        if (!req.files)
            req.files = {};

        if (name != "weights") {
            // Not the file we expected, flush the stream and do nothing
            //
            file_stream.on("readable", file_stream.read);
            return;
        }

        const temp_file = path.join(os.tmpdir(), file_name);
        // Pipes
        //   - file_stream.pipe(fs_stream)
        //   - file_stream.pipe(gunzip_stream)
        //       - gunzip_stream.pipe(hasher)
        //       - gunzip_stream.pipe(parser)
        file_promise = new Promise((resolve, reject) => {
            const fs_stream = file_stream.pipe(fs.createWriteStream(temp_file)).on("error", reject);
            const gunzip_stream = file_stream.pipe(zlib.createGunzip()).on("error", reject);

            Promise.all([
                new Promise(resolve => {
                    fs_stream.on("finish", () => resolve({ path: fs_stream.path }));
                }),
                new Promise(resolve => {
                    const hasher = gunzip_stream.pipe(crypto.createHash("sha256")).on("finish", () => resolve({ hash: hasher.read().toString("hex") }));
                }),
                new Promise(resolve => {
                    const parser = gunzip_stream.pipe(new weight_parser()).on("finish", () => resolve(parser.read()));
                })
            ]).then(results => {
                // consolidate results
                results = req.files[name] = Object.assign.apply(null, results);

                // Move temp file to network folder with hash name
                results.path = path.join(__dirname, "network", results.hash + ".gz");
                if (fs.existsSync(temp_file))
                    fs.moveSync(temp_file, results.path, { overwrite: true });

                // We are all done (hash, parse and save file)
                resolve();
            });
        }).catch(err => {
            console.error(err);
            req.files[name] = { error: err };

            // Clean up, flush stream and delete temp file
            file_stream.on("readable", file_stream.read);

            if (fs.existsSync(temp_file))
                fs.removeSync(temp_file);
        });
    }).on("finish", async() => {
        await file_promise;

        if (!req.body.key || req.body.key != auth_key) {
            console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");
            return res.status(400).send("Incorrect key provided.");
        }

        if (!req.files || !req.files.weights)
            return res.status(400).send("No weights file was uploaded.");

        if (req.files.weights.error)
            return res.status(400).send(req.files.weights.error.message);

        const set = {
            hash: req.files.weights.hash,
            ip: req.ip,
            training_count: +req.body.training_count || null,
            training_steps: +req.body.training_steps || null,
            filters: req.files.weights.filters,
            blocks: req.files.weights.blocks,
            description: req.body.description
        };

        // No training count given, we'll calculate it from database.
        //
        if (!set.training_count) {
            const cursor = db.collection("networks").aggregate([{ $group: { _id: 1, count: { $sum: "$game_count" } } }]);
            const totalgames = await cursor.next();
            set.training_count = (totalgames ? totalgames.count : 0);
        }

        // Prepare variables for printing messages
        //
        const { blocks, filters, hash, training_count } = set;

        db.collection("networks").updateOne(
            { hash: set.hash },
            { $set: set },
            { upsert: true },
            (err, dbres) => {
                if (err) {
                    res.end(err.message);
                    console.error(err);
                } else {
                    const msg = "Network weights (" + blocks + " x " + filters + ") " + hash + " (" + training_count + ") " + (dbres.upsertedCount == 0 ? "exists" : "uploaded") + "!";
                    res.end(msg);
                    console.log(msg);
                    log_memory_stats("submit network ends");
                }
            }
        );
    });
}));

app.post("/submit-match", asyncMiddleware(async(req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) /submit-match: ${msg}`);
        console.log(`files: ${JSON.stringify(Object.keys(req.files || {}))}, body: ${JSON.stringify(req.body)}`);
        return res.status(400).send(msg);
    };

    if (!req.files)
        return logAndFail("No files were uploaded.");

    if (!req.files.sgf)
        return logAndFail("No sgf file provided.");

    if (!req.body.clientversion)
        return logAndFail("No clientversion provided.");

    if (!req.body.winnerhash)
        return logAndFail("No winner hash provided.");

    if (!req.body.loserhash)
        return logAndFail("No loser hash provided.");

    if (!req.body.winnercolor)
        return logAndFail("No winnercolor provided.");

    if (!req.body.movescount)
        return logAndFail("No movescount provided.");

    if (!req.body.score)
        return logAndFail("No score provided.");

    if (!req.body.options_hash)
        return logAndFail("No options_hash provided.");

    if (!req.body.random_seed)
        return logAndFail("No random_seed provided.");

    if (!check_match_verification(req.body))
        return logAndFail("Verification failed.");

    // Convert random_seed to Long, which is signed, after verifying the string
    req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    req.body.task_time = get_timestamp_from_seed(req.body.random_seed);

    // verify match exists in database
    let match = await db.collection("matches").findOne(
        {
            $or: [
                { network1: req.body.winnerhash, network2: req.body.loserhash },
                { network2: req.body.winnerhash, network1: req.body.loserhash }
            ],
            options_hash: req.body.options_hash
        }
    );

    // Match not found, abort!!
    if (!match)
        return logAndFail("Match not found.");

    // Verify random_seed for the match hasn't been used
    if (await db.collection("match_games").findOne(
        {
            random_seed: req.body.random_seed,
            $or: [
                { winnerhash: req.body.winnerhash, loserhash: req.body.loserhash },
                { loserhash: req.body.winnerhash, winnerhash: req.body.loserhash }
            ],
            options_hash: req.body.options_hash
        }
    ))
        return logAndFail("Upload match with duplicate random_seed.");

    // calculate sgfhash
    try {
        const sgfbuffer = await new Promise((resolve, reject) => zlib.unzip(req.files.sgf.data, (err, res) => {
            if (err) {
                reject(err);
            } else {
                resolve(res);
            }
        }));
        const sgfhash = checksum(sgfbuffer, "sha256");

        // upload match game to database
        const dbres = await db.collection("match_games").updateOne(
            { sgfhash },
            {
                $set: {
                    ip: req.ip, winnerhash: req.body.winnerhash, loserhash: req.body.loserhash, sgf: sgfbuffer.toString(),
                    options_hash: req.body.options_hash,
                    clientversion: Number(req.body.clientversion), winnercolor: req.body.winnercolor,
                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                    score: req.body.score,
                    random_seed: req.body.random_seed
                }
            },
            { upsert: true }
        );

        // Not inserted, we got duplicate sgfhash, abort!
        if (!dbres.upsertedId)
            return logAndFail("Upload match with duplicate sgf.");

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) uploaded in ${Math.round(Date.now() / 1000 - req.body.task_time)}s match: ${sgfhash}`);
        res.send("Match data " + sgfhash + " stored in database\n");
    } catch (err) {
        console.error(err);
        return logAndFail("Error with sgf.");
    }

    // prepare $inc
    const $inc = { game_count: 1 };
    const is_network1_win = (match.network1 == req.body.winnerhash);
    if (is_network1_win)
        $inc.network1_wins = 1;
    else
        $inc.network1_losses = 1;

    // save to database using $inc and get modified document
    match = (await db.collection("matches").findOneAndUpdate(
        { _id: match._id },
        { $inc },
        { returnOriginal: false } // return modified document
    )).value;

    // get latest SPRT result
    const sprt_result = SPRT(match.network1_wins, match.network1_losses);
    const pending_match_index = pending_matches.findIndex(m => m._id.equals(match._id));

    // match is found in pending_matches
    if (pending_match_index >= 0) {
        const m = pending_matches[pending_match_index];

        if (sprt_result === false) {
            // remove from pending matches
            console.log("SPRT: Early fail pop: " + JSON.stringify(m));
            pending_matches.splice(pending_match_index, 1);
            console.log("SPRT: Early fail post-pop: " + JSON.stringify(pending_matches));
        } else {
            // remove the match from the requests array.
            const index = m.requests.findIndex(e => e.seed === seed_from_mongolong(req.body.random_seed));
            if (index !== -1) {
                m.requests.splice(index, 1);
            }

            // update stats
            m.game_count++;
            if (m.network1 == req.body.winnerhash) {
                m.network1_wins++;
            } else {
                m.network1_losses++;
            }

            if (sprt_result === true) {
                console.log("SPRT: Early pass unshift: " + JSON.stringify(m));
                pending_matches.splice(pending_match_index, 1); // cut out the match
                if (m.game_count < m.number_to_play) pending_matches.unshift(m); // continue a SPRT pass at end of queue
                console.log("SPRT: Early pass post-unshift: " + JSON.stringify(pending_matches));
            }
        }
    }

    // Lastly, promotion check!!
    const best_network_hash = await get_best_network_hash();
    if (
        // Best network was being challenged
        match.network2 == best_network_hash
        // This is not a test match
        && !match.is_test
        // SPRT passed OR it has reach 55% after 400 games (stick to the magic number)
        && (
            sprt_result === true
            || (match.game_count >= 400 && match.network1_wins / match.game_count >= 0.55)
        )) {
        const promote_hash = match.network1;
        const promote_file = `${__dirname}/network/${promote_hash}.gz`;
        fs.copyFileSync(promote_file, __dirname + "/network/best-network.gz");
        console.log(`New best network copied from ${promote_file}`);
        discord.network_promotion_notify(promote_hash);
    }

    dbutils.update_matches_stats_cache(db, match._id, is_network1_win);
    cachematches.clear(() => console.log("Cleared match cache."));
}));

// curl -F 'networkhash=abc123' -F 'file=@zero.prototxt' http://localhost:8080/submit
// curl -F 'networkhash=abc123' -F 'sgf=@zero.prototxt' -F 'trainingdata=@zero.prototxt' http://localhost:8080/submit

app.post("/submit", (req, res) => {
    const logAndFail = msg => {
        console.log(`${req.ip} (${req.headers["x-real-ip"]}) /submit: ${msg}`);
        console.log(`files: ${JSON.stringify(Object.keys(req.files || {}))}, body: ${JSON.stringify(req.body)}`);
        return res.status(400).send(msg);
    };

    if (!req.files)
        return logAndFail("No files were uploaded.");

    if (!req.files.sgf)
        return logAndFail("No sgf file provided.");

    if (!req.files.trainingdata)
        return logAndFail("No trainingdata file provided.");

    if (!req.body.clientversion)
        return logAndFail("No clientversion provided.");

    if (!req.body.networkhash)
        return logAndFail("No network hash provided.");

    if (!req.body.winnercolor)
        return logAndFail("No winnercolor provided.");

    if (!req.body.movescount)
        return logAndFail("No movescount provided.");

    if (!req.body.options_hash)
        return logAndFail("No options_hash provided.");

    if (!req.body.random_seed)
        return logAndFail("No random_seed provided.");

    req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    req.body.task_time = get_timestamp_from_seed(req.body.random_seed);

    const clientversion = req.body.clientversion;
    const networkhash = req.body.networkhash;
    let trainingdatafile;
    let sgffile;
    let sgfhash;

    const sgfbuffer = Buffer.from(req.files.sgf.data);
    const trainbuffer = Buffer.from(req.files.trainingdata.data);

    if (req.ip == "xxx") {
        res.send("Game data " + sgfhash + " stored in database\n");
        console.log("FAKE/SPAM reply sent to " + "xxx" + " (" + req.headers["x-real-ip"] + ")");
    } else {
    zlib.unzip(sgfbuffer, (err, sgfbuffer) => {
        if (err) {
            console.error(err);
            return logAndFail("Error with sgf.");
        } else {
            sgffile = sgfbuffer.toString();
            sgfhash = checksum(sgffile, "sha256");

            zlib.unzip(trainbuffer, (err, trainbuffer) => {
                if (err) {
                    console.error(err);
                    return logAndFail("Error with trainingdata.");
                } else {
                    trainingdatafile = trainbuffer.toString();

                    db.collection("games").updateOne(
                        { sgfhash },
                        { $set: { ip: req.ip, networkhash, sgf: sgffile, options_hash: req.body.options_hash,
                                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                                data: trainingdatafile, clientversion: Number(clientversion),
                                    winnercolor: req.body.winnercolor, random_seed: req.body.random_seed } },
                  { upsert: true },
                        err => {
                            // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                            //
                            if (err) {
                                console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded game #" + counter + ": " + sgfhash + " ERROR: " + err);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            } else {
                                let message = `in ${Math.round(Date.now() / 1000 - req.body.task_time)}s `;
                                if (ELF_NETWORKS.includes(networkhash)) {
                                    elf_counter++;
                                    message += `ELF game #${elf_counter}`;
                                } else {
                                    counter++;
                                    message += `LZ game #${counter}`;
                                }
                                console.log(`${req.ip} (${req.headers["x-real-ip"]}) uploaded ${message}: ${sgfhash}`);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            }
                        }
                    );

                    db.collection("networks").updateOne(
                        { hash: networkhash },
                        { $inc: { game_count: 1 } },
                        { },
                        err => {
                            if (err) {
                                if (ELF_NETWORKS.includes(networkhash))
                                    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded ELF game #" + elf_counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
                                else
                                    console.log(req.ip + " (" + req.headers["x-real-ip"] + ") " + " uploaded LZ game #" + counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
                            } else {
                                //console.log("Incremented " + networkhash);
                            }
                        }
                    );
                }
            });
        }
    });
    }
});

app.get("/matches", asyncMiddleware(async(req, res) => {
    const pug_data = {
        matches: await dbutils.get_matches_from_cache(db)
    };

    res.render("matches", pug_data);
}));

app.get("/matches-all", asyncMiddleware(async(req, res) => {
    const pug_data = {
        matches: await dbutils.get_matches_from_db(db, { limit: 1000000 })
    };

    res.render("matches-all", pug_data);
}));

app.get("/network-profiles", asyncMiddleware(async(req, res) => {
    const networks = await db.collection("networks")
        .find({
            hash: { $not: { $in: ELF_NETWORKS } },
            $or: [
                { game_count: { $gt: 0 } },
                { hash: get_best_network_hash() }
            ]
        })
        .sort({ _id: -1 })
        .toArray();

    const pug_data = { networks, menu: "network-profiles" };

    pug_data.networks.forEach(network => {
        network.time = network._id.getTimestamp().getTime();
    });

    res.render("networks/index", pug_data);
}));

app.get("/network-profiles/:hash(\\w+)", asyncMiddleware(async(req, res) => {
    const network = await db.collection("networks")
        .findOne({ hash: req.params.hash });

    if (!network) {
        return res.status(404).render("404");
    }

    // If it's one of the best network, then find it's #
    if ((network.game_count > 0 || network.hash == get_best_network_hash()) && !ELF_NETWORKS.includes(network.hash)) {
        network.networkID = await db.collection("networks")
            .count({
                _id: { $lt: network._id },
                game_count: { $gt: 0 },
                hash: { $not: { $in: ELF_NETWORKS } }
            });
    }

    // Prepare Avatar
    const avatar_folder = path.join(__dirname, "static", "networks");
    if (!await fs.pathExists(avatar_folder)) {
        await fs.mkdirs(avatar_folder);
    }

    const avatar_path = path.join(avatar_folder, network.hash + ".png");
    if (!fs.pathExistsSync(avatar_path)) {
        const retricon = require("retricon-without-canvas");

        await new Promise((resolve, reject) => {
            // GitHub style
            retricon(network.hash, { pixelSize: 70, imagePadding: 35, bgColor: "#F0F0F0" })
                .pngStream()
                .pipe(fs.createWriteStream(avatar_path))
                .on("finish", resolve)
                .on("error", reject);
        });
    }

    const pug_data = {
        network,
        http_host: req.protocol + "://" + req.get("host"),
        // Have to fetch from db since we only cache 100 recent matches
        matches: await dbutils.get_matches_from_db(db, { network: network.hash }),
        menu: "network-profiles"
    };

    res.render("networks/profile", pug_data);
}));

app.get("/rss", asyncMiddleware(async(req, res) => {
    const rss_path = path.join(__dirname, "static", "rss.xml");
    const best_network_path = path.join(__dirname, "network", "best-network.gz");
    let should_generate = true;
    const http_host = req.protocol + "://" + req.get("host");

    const rss_exists = await fs.pathExists(rss_path);

    if (rss_exists) {
        const best_network_mtimeMs = (await fs.stat(best_network_path)).mtimeMs;
        const rss_mtimeMs = (await fs.stat(rss_path)).mtimeMs;

        // We have new network promoted since rss last generated
        should_generate = best_network_mtimeMs > rss_mtimeMs;
    }

    if (should_generate || req.query.force) {
        const hash = await get_best_network_hash();
        const networks = await db.collection("networks")
            .find({ $or: [{ game_count: { $gt: 0 } }, { hash }], hash: { $not: { $in: ELF_NETWORKS } } })
            .sort({ _id: 1 })
            .toArray();

        const rss_xml = new rss_generator().generate(networks, http_host);

        await fs.writeFile(rss_path, rss_xml);
    }

    res.setHeader("Content-Type", "application/rss+xml");
    res.sendFile(rss_path);
}));

app.get("/home", asyncMiddleware(async(req, res) => {
    const client_list_24hr = await cacheIP24hr.wrap(
        "IP24hr", "5m",
        () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } })));

    const client_list_1hr = await cacheIP1hr.wrap("IP1hr", "30s", () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } })));

    const selfplay_24hr = await db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count();

    const selfplay_1hr = await db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count();

    const match_total = await db.collection("match_games").find().count();

    const match_24hr = await db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count();

    const match_1hr = await db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count();

    const pug_data = {
        matches: await dbutils.get_matches_from_cache(db, 10),
        stats: {
            client_24hr: client_list_24hr.length,
            client_1hr: client_list_1hr.length,
            selfplay_total: counter,
            selfplay_24hr,
            selfplay_1hr,
            selfplay_elf: elf_counter,
            match_total,
            match_24hr,
            match_1hr
        }
    };

    res.render("index", pug_data);
}));

app.get("/", asyncMiddleware(async(req, res) => {
    console.log(req.ip + " Sending index.html");

    let network_table = "<table class=\"networks-table\" border=1><tr><th colspan=7>Best Network Hash</th></tr>\n";
    network_table += "<tr><th>#</th><th>Upload Date</th><th>Hash</th><th>Size</th><th>Elo</th><th>Games</th><th>Training #</th></tr>\n";

    let styles = "";

    // Display some self-play for all and by current ip
    const recentSelfplay = {};
    const selfplayProjection = { _id: 0, movescount: 1, networkhash: 1, sgfhash: 1, winnercolor: 1 };
    const saveSelfplay = type => games => {
        recentSelfplay[type] = games.map(({ movescount, networkhash, sgfhash, winnercolor }) => ({
            sgfhash,
            text: `${networkhash.slice(0, 4)}/${movescount}${winnercolor.slice(0, 1)}`
        }));
        return "";
    };

    const cursor = db.collection("networks").aggregate([ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    const totalgames = await cursor.next();

    const best_network_hash = await get_best_network_hash();

    Promise.all([
        cacheIP24hr.wrap("IP24hr", "5m", () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } })))
        .then(list => (list.length + " clients in past 24 hours, ")),
        cacheIP1hr.wrap("IP1hr", "30s", () => Promise.resolve(db.collection("games").distinct("ip", { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } })))
        .then(list => (list.length + " in past hour.<br>")),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count()
        .then(count => `${counter} total <a href="/self-plays">self-play games</a> (${count} in past 24 hours, `),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count()
        .then(count => `${count} in past hour, <a href="https://github.com/gcp/leela-zero/issues/1311#issuecomment-386422486">includes ${elf_counter} ELF</a>).<br/>`),
        db.collection("match_games").find().count()
        .then(count => `${count} total match games (`),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60 * 24) } }).count()
        .then(count => `${count} in past 24 hours, `),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60) } }).count()
        .then(count => `${count} in past hour).<br>`),
        db.collection("networks").aggregate([
            // Exclude ELF network
            { $match: { $and: [{ game_count: { $gt: 0 } }, { hash: { $not: { $in: ELF_NETWORKS } } }] } },
            { $sort: { _id: 1 } },
            { $group: { _id: 1, networks: { $push: { _id: "$_id", hash: "$hash", game_count: "$game_count", training_count: "$training_count", filters: "$filters", blocks: "$blocks" } } } },
            { $unwind: { path: "$networks", includeArrayIndex: "networkID" } },
            { $project: { _id: "$networks._id", hash: "$networks.hash", game_count: "$networks.game_count", training_count: "$networks.training_count", filters: "$networks.filters", blocks: "$networks.blocks", networkID: 1 } },
            { $sort: { networkID: -1 } },
            { $limit: 10000 }
        ])
        //db.collection("networks").find({ game_count: { $gt: 0 } }, { _id: 1, hash: 1, game_count: 1, training_count: 1}).sort( { _id: -1 } ).limit(100)
        .toArray()
        .then(list => {
            for (const item of list) {
                const itemmoment = new moment(item._id.getTimestamp());

                totalgames.count -= item.game_count;

                if (!ELF_NETWORKS.includes(item.hash)) network_table += "<tr><td>"
                    + item.networkID
                    + "</td><td>"
                    + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm")
                    + "</td><td><a href=\"/networks/"
                    + item.hash
                    + ".gz\">"
                    + item.hash.slice(0, 8)
                    + "</a></td><td>"
                    + (item.filters && item.blocks ? `${item.blocks}x${item.filters}` : "TBD")
                    + "</td><td>"
                    + ~~bestRatings.get(item.hash)
                    + "</td><td>"
                    + item.game_count
                    + "</td><td>"
                    + ((item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count)
                    + "</td></tr>\n";
            }

            network_table += "</table>\n";
            return "";
        }),
        db.collection("games").find({ ip: req.ip }, selfplayProjection).hint("ip_-1__id_-1").sort({ _id: -1 }).limit(10).toArray()
        .then(saveSelfplay("ip")),
        db.collection("match_games").find(
            { winnerhash: best_network_hash },
            { _id: 0, winnerhash: 1, loserhash: 1, sgfhash: 1 }
        ).sort({ _id: -1 }).limit(1).toArray()
        .then(game => {
            if (game[0]) {
                return "<br>"
                    + "View most recent match win by best network " + game[0].winnerhash.slice(0, 8) + " vs " + game[0].loserhash.slice(0, 8) + ": "
                    + "[<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=eidogo\">EidoGo</a> / "
                    + "<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=wgo\">WGo</a>] "
                    + "<br>";
            } else {
                return "";
            }
        }),
        db.collection("games").find({}, selfplayProjection).sort({ _id: -1 }).limit(10).toArray()
        .then(saveSelfplay("all")),
        cachematches.wrap("matches", "1d", () => Promise.resolve(
        db.collection("matches").aggregate([ { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "merged" } }, { $unwind: "$merged" }, { $lookup: { localField: "network1", from: "networks", foreignField: "hash", as: "merged1" } }, { $unwind: "$merged1" }, { $sort: { _id: -1 } }, { $limit: 100 } ])
        .toArray()
        .then(list => {
            let match_table = "<table class=\"matches-table\" border=1><tr><th colspan=5>Test Matches (100 Most Recent)</th></tr>\n";
            match_table += "<tr><th>Start Date</th><th>Network Hashes</th><th>Wins / Losses</th><th>Games</th><th>SPRT</th></tr>\n";
            styles += ".match-test { background-color: rgba(0,0,0,0.1); font-style: italic; }\n";

            for (const item of list) {
                // The aggregate query above should not return any null network2 matches, but let's be safe.
                //
                if (item.network2 === null) continue;

                let win_percent = item.game_count ? (100 * item.network1_wins / item.game_count).toFixed(2) : null;
                const itemmoment = new moment(item._id.getTimestamp());

                if (win_percent) {
                    if (win_percent >= 55) {
                        win_percent = "<b>" + win_percent + "</b>";
                    }
                    win_percent = " (" + win_percent + "%)";
                }

                match_table += `<tr class="match-${item.is_test ? "test" : "regular"}">`
                    + "<td>" + itemmoment.utcOffset(1).format("YYYY-MM-DD HH:mm") + "</td>"
                    + "<td>"
                    + "<div class=\"tooltip\">"
                    + "<a href=\"/networks/" + item.network1 + ".gz\">" + item.network1.slice(0, 8) + "</a>"
                    + "<span class=\"tooltiptextleft\">"
                    + item.merged1.training_count.abbr(4)
                    + (item.merged1.training_steps ? "+" + item.merged1.training_steps.abbr(3) : "")
                    + (item.merged1.filters && item.merged1.blocks ? `<br/>${item.merged1.blocks}x${item.merged1.filters}` : "")
                    + (item.merged1.description ? `<br/>${item.merged1.description}` : "")
                    + "</span></div>&nbsp;"
                    + "<div class=\"tooltip\">"
                    + " <a href=\"/match-games/" + item._id + "\">VS</a> "
                    + "<span class=\"tooltiptextright\">"
                    + (item.is_test ? "Test" : "Regular") + " Match"
                    + "</span>"
                    + "</div>&nbsp;"
                    ; // eslint-disable-line semi-style

                if (item.network2) {
                    match_table += "<div class=\"tooltip\">"
                        + "<a href=\"/networks/" + item.network2 + ".gz\">" + item.network2.slice(0, 8) + "</a>"
                        + "<span class=\"tooltiptextright\">"
                        + item.merged.training_count.abbr(4)
                        + (item.merged.training_steps ? "+" + item.merged.training_steps.abbr(3) : "")
                        + (item.merged.filters && item.merged.blocks ? `<br/>${item.merged.blocks}x${item.merged.filters}` : "")
                        + (item.merged.description ? `<br/>${item.merged.description}` : "")
                        + "</span></div>";
                } else {
                    match_table += "BEST";
                }

                match_table += "</td>"
                    + "<td>" + item.network1_wins + " : " + item.network1_losses
                        + (win_percent ? win_percent + "</td>" : "</td>")
                    + "<td>" + item.game_count + " / " + item.number_to_play + "</td>"
                    + "<td>";

                // Treat non-test match that has been promoted as PASS
                const promotedMatch = bestRatings.has(item.network1) && !item.is_test;
                switch (promotedMatch || SPRT(item.network1_wins, item.network1_losses)) {
                    case true:
                        match_table += "<b>PASS</b>";
                        break;
                    case false:
                        match_table += "<i>fail</i>";
                        break;
                    default: {
                        // -2.9444389791664403 2.9444389791664403 == range of 5.88887795833
                        let width = Math.round(100 * (2.9444389791664403 + LLR(item.network1_wins, item.network1_losses, 0, 35)) / 5.88887795833);
                        let color;

                        if (width < 0) {
                            color = "C11B17";
                            width = 0;
                        } else if (width > 100) {
                            color = "0000FF";
                            width = 100;
                        } else {
                            color = "59E817";
                        }

                        styles += ".n" + item.network1.slice(0, 8) + "{ width: " + width + "%; background-color: #" + color + ";}\n";
                        match_table += "<div class=\"n" + item.network1.slice(0, 8) + "\">&nbsp;</div>";
                    }
                }

                match_table += "</td></tr>\n";
            }

            match_table += "</table>\n";
            return [styles, match_table];
        })
        ))
    ]).then(responses => {
        const match_and_styles = responses.pop();

        const styles = match_and_styles[0];
        const match_table = match_and_styles[1];

        let page = "<html><head>\n<title>Leela Zero</title>\n";
        page += "<link rel=\"alternate\" type=\"application/rss+xml\" title=\"Leela Zero Best Networks\" href=\"http://zero.sjeng.org/rss\" />";
        page += "<script type=\"text/javascript\" src=\"/static/timeago.js\"></script>\n";
        page += "<style>";
        page += "table.networks-table { float: left; margin-right: 40px; margin-bottom: 20px; }\n";
        page += styles;

        // From https://www.w3schools.com/css/css_tooltip.asp
        //
        page += ".tooltip { position: relative; display: inline-block; border-bottom: 1px dotted black; }\n";

        page += ".tooltip .tooltiptextright { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; left: 110%; }\n";
        page += " .tooltip .tooltiptextright::after { content: \"\"; position: absolute; top: 50%; right: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent black transparent transparent; }\n";
        page += " .tooltip:hover .tooltiptextright { visibility: visible; }\n";

        page += ".tooltip .tooltiptextleft { visibility: hidden; width: 130px; background-color: black; color: #fff; text-align: center; border-radius: 6px; padding: 5px 0; position: absolute; z-index: 1; top: -5px; right: 110%; }\n";
        page += " .tooltip .tooltiptextleft::after { content: \"\"; position: absolute; top: 50%; left: 100%; margin-top: -5px; border-width: 5px; border-style: solid; border-color: transparent transparent transparent black; }\n";
        page += " .tooltip:hover .tooltiptextleft { visibility: visible; }\n";

        page += "</style>\n";
        page += "</head><body>\n";

        page += "Leela Zero is available from: <a href=\"https://github.com/gcp/leela-zero\">Github</a>.<br>";
        page += "Check out the <a href=\"https://github.com/gcp/leela-zero/blob/master/FAQ.md\">FAQ</a> and ";
        page += "<a href=\"https://github.com/gcp/leela-zero/blob/master/README.md\">README</a>.<br>";
        page += "<br>A new front page is being tested at <a href=\"http://zero.sjeng.org/home\">http://zero.sjeng.org/home</a>. Please review and provide feedback <a href=\"https://github.com/gcp/leela-zero-server/issues/170\">here</a>.<br>";
        page += "<br>Autogtp will automatically download better networks once found.<br>";
        page += "Not each trained network will be a strength improvement over the prior one. Patience please. :)<br>";
        page += "Match games are played at full strength (only 1600 visits).<br>";
        page += "Self-play games are played with some randomness and noise for all moves.<br>";
        page += "Training data from self-play games are full strength even if plays appear weak.<br>";
        page += "<br>";
        page += "2019-04-04 <a href=\"https://github.com/gcp/leela-zero/releases\">Leela Zero 0.17 + AutoGTP v18</a>.<br>";
        page += "2018-10-31 <a href=\"https://github.com/gcp/leela-zero/releases\">Leela Zero 0.16 + AutoGTP v17</a>.<br>";
        page += "2018-07-28 Force promoted V20-2 as new 20 block starting point network. Selfplay and matches now use 1600 visits.<br>";
        page += "<br>";

        responses.map(response => page += response);

        ["all", "ip"].forEach(type => {
            const games = recentSelfplay[type];
            if (games && games.length) {
                page += `View ${type == "ip" ? "your " : ""}most recent self-play games: `;
                page += games.map(({ sgfhash, text }) => `<a href="/view/${sgfhash}?viewer=wgo">${text}</a>`).join(", ");
                page += "<br>";
            }
        });

        page += "<br><br>";
        page += "<a href=\"https://sjeng.org/zero/\">Raw SGF files</a>.<br>";
        page += "<a href=\"https://docs.google.com/spreadsheets/d/e/2PACX-1vTsHu7T9vbfLsYOIANnUX9rHAYu7lQ4AlpVIvCfn60G7BxNZ0JH4ulfbADEedPVgwHxaH5MczdH853l/pubchart?oid=286613333&format=interactive\">Original strength graph</a>. (Mostly obsolete.)<br>";
        page += "<br>";
        page += "<h4>Recent Strength Graph (<a href=\"/static/elo.html\">Full view</a>.)</h4>";
        page += "<iframe width=\"950\" height=\"655\" seamless frameborder=\"0\" scrolling=\"no\" src=\"/static/elo.html?0#recent=2500000\"></iframe><script>(i => i.contentWindow.location = i.src)(document.querySelector(\"iframe\"))</script>";
        page += "<br><br>Times are in GMT+0100 (CET)<br>\n";
        page += network_table;
        page += match_table;
        page += "</body></html>";
        res.send(page);
    });
}));

/**
 * Determine if a match should be scheduled for a given request.
 *
 * @param req {object} Express request
 * @param now {int} Timestamp right now
 * @returns {bool|object} False if no match to schedule; otherwise, match object
 */
function shouldScheduleMatch(req, now) {
  if (!(pending_matches.length && req.params.autogtp != 0 && fastClientsMap.get(req.ip))) {
    return false;
  }

  // Find the first match this client can play
  let match;
  let i = pending_matches.length;
  while (--i >= 0) {
    match = pending_matches[i];
    break;
  }

  // Don't schedule if we ran out of potential matches for this client
  if (i < 0) return false;

  const deleted = match.requests.filter(e => e.timestamp < now - MATCH_EXPIRE_TIME).length;
  const oldest = (match.requests.length > 0 ? (now - match.requests[0].timestamp) / 1000 / 60 : 0).toFixed(2);
  match.requests.splice(0, deleted);
  const requested = match.requests.length;
  const needed = how_many_games_to_queue(
                match.number_to_play,
                match.network1_wins,
                match.network1_losses,
                PESSIMISTIC_RATE,
                bestRatings.has(match.network1));
  const result = needed > requested;
  console.log(`Need ${needed} match games. Requested ${requested}, deleted ${deleted}. Oldest ${oldest}m ago. Will schedule ${result ? "match" : "selfplay"}.`);

  return result && match;
}

/**
 * Get a self-play or match task depending on various client versions.
 * E.g., /get-task/0, /get-task/16, /get-task/0/0.14, /get-task/16/0.14
 */
app.get("/get-task/:autogtp(\\d+)(?:/:leelaz([.\\d]+)?)", asyncMiddleware(async(req, res) => {
    const required_client_version = String(16);
    const required_leelaz_version = String("0.15");

    // Pulling this now because if I wait inside the network2==null test, possible race condition if another get-task pops end of array?
    //
    const best_network_hash = await get_best_network_hash();
    const now = Date.now();
    const random_seed = make_seed(now / 1000).toString();

    // Track match assignments as they go out, so we don't send out too many. If more needed request them, otherwise selfplay.
    //
    const match = shouldScheduleMatch(req, now);
    if (match) {
        const task = { cmd: "match", required_client_version, minimum_autogtp_version: required_client_version, random_seed, minimum_leelaz_version: required_leelaz_version };

        if (match.options.visits) match.options.playouts = "0";

        task.options = match.options;
        task.options_hash = match.options_hash;

        if (match.network2 == null) {
            match.network2 = best_network_hash;

            db.collection("matches").updateOne(
                { network1: match.network1, network2: null, options_hash: match.options_hash },
                { $set: { network2: best_network_hash } },
                { },
                err => {
                    if (err) {
                        console.log("ERROR: /get-task setting network2: " + err);
                        res.send("ERROR: /get-task setting network2: " + err);
                        return;
                    }
                    dbutils.clear_matches_cache();
                    console.log("Match " + match._id + " set network2 to best: " + match.network2);
            });
        }

        match.game_color = !match.game_color;

        if (match.game_color) {
            task.white_hash = match.network1;
            task.black_hash = match.network2;
        } else {
            task.white_hash = match.network2;
            task.black_hash = match.network1;
        }

        add_match_verification(task);
        await add_gzip_hash(task);
        res.send(JSON.stringify(task));

        match.requests.push({ timestamp: now, seed: random_seed });

        if (match.game_count >= match.number_to_play) pending_matches.pop();

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) got task: match ${match.network1.slice(0, 8)} vs ${match.network2.slice(0, 8)} ${match.game_count + match.requests.length} of ${match.number_to_play} ${JSON.stringify(task)}`);
//    } else if ( req.params.autogtp==1 && Math.random() > .2 ) {
//        const task = { "cmd": "wait", "minutes": "5" };
//
//        res.send(JSON.stringify(task));
//
//        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: wait");
    } else {
        // {"cmd": "selfplay", "hash": "xxx", "playouts": 1000, "resignation_percent": 3.0}
        const task = { cmd: "selfplay", hash: "", required_client_version, minimum_autogtp_version: required_client_version, random_seed, minimum_leelaz_version: required_leelaz_version };

        //var options = {"playouts": "1600", "resignation_percent": "10", "noise": "true", "randomcnt": "30"};
        const options = { playouts: "0", visits: "1601", resignation_percent: "5", noise: "true", randomcnt: "30" };

        if (Math.random() < 0.1) options.resignation_percent = "0";

        task.hash = best_network_hash;

        // For now, have newer autogtp and leelaz play some self-play with
        // Facebook's ELF Open Go network, which uses network version 2.
        //if ((req.params.autogtp >= 16 || req.params.leelaz >= 0.14) && Math.random() < 0.25) {
        //    task.hash = ELF_NETWORKS[1];
        //    options.resignation_percent = "5";
        //}

        //task.options_hash = checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
        task.options_hash = get_options_hash(options);
        task.options = options;
        await add_gzip_hash(task);
        res.send(JSON.stringify(task));

        console.log(`${req.ip} (${req.headers["x-real-ip"]}) got task: selfplay ${JSON.stringify(task)}`);
    }
}));

app.get("/view/:hash(\\w+).sgf", (req, res) => {
    db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        res.setHeader("Content-Disposition", "attachment; filename=\"" + req.params.hash + ".sgf\"");
        res.setHeader("Content-Type", "application/x-go-sgf");
        res.send(sgf);
    }).catch(() => {
        res.send("No self-play was found with hash " + req.params.hash);
    });
});

app.get("/view/:hash(\\w+)", (req, res) => {
    db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        switch (req.query.viewer) {
            case "eidogo":
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
                break;
            case "wgo":
                res.render("wgo", { title: "View training game " + req.params.hash, sgf });
                break;
            default:
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
        }
    }).catch(() => {
        res.send("No selfplay game was found with hash " + req.params.hash);
    });
});

app.get("/self-plays", (req, res) => {
    db.collection("games").find({}, { data: 0 }).sort({ _id: -1 }).limit(400).toArray()
    .then(list => {
        process_games_list(list, req.ip);
        // render pug view self-plays
        res.render("self-plays", { data: list });
    }).catch(() => {
        res.send("Failed to get recent self-play games");
    });
});

app.get("/match-games/:matchid(\\w+)", (req, res) => {
    if (!req.params.matchid) {
        res.send("matchid missing");
        return;
    }

    db.collection("matches").findOne({ _id: new ObjectId(req.params.matchid) })
        .then(match => {
            db.collection("match_games").aggregate([
                {
                    $match: {
                        $or: [
                            { winnerhash: match.network1, loserhash: match.network2, options_hash: match.options_hash },
                            { winnerhash: match.network2, loserhash: match.network1, options_hash: match.options_hash }
                        ]
                    }
                },
                { $sort: { _id: 1 } }
            ]).toArray()
                .then(list => {
                    process_games_list(list, req.ip, match.network1);
                    // render pug view match-games
                    res.render("match-games", { data: list });
                }).catch(() => {
                    res.send("No matches found for match " + req.params.matchid);
                });
        }).catch(() => {
            res.send("No match found for id " + req.params.hash);
        });
});

app.get("/viewmatch/:hash(\\w+).sgf", (req, res) => {
    db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        res.setHeader("Content-Disposition", "attachment; filename=\"" + req.params.hash + ".sgf\"");
        res.setHeader("Content-Type", "application/x-go-sgf");
        res.send(sgf);
    }).catch(() => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

app.get("/viewmatch/:hash(\\w+)", (req, res) => {
    db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
    .then(({ sgf }) => {
        sgf = sgf.replace(/(\n|\r)+/g, "");

        switch (req.query.viewer) {
            case "eidogo":
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
                break;
            case "wgo":
                res.render("wgo", { title: "View match " + req.params.hash, sgf });
                break;
            default:
                res.render("eidogo", { title: "View training game " + req.params.hash, sgf });
        }
    }).catch(() => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

app.get("/data/elograph.json", asyncMiddleware(async(req, res) => {
    // cache in `cachematches`, so when new match result is uploaded, it gets cleared as well
    const json = await cachematches.wrap("elograph", "1d", async() => {
    console.log("fetching data for elograph.json, should be called once per day or when `cachematches` is cleared");

    const cursor = db.collection("networks").aggregate([ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    const totalgames = await cursor.next();

    return Promise.all([
        db.collection("networks").find().sort({ _id: -1 }).toArray(),
        db.collection("matches").aggregate([
            { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "merged" } },
            { $unwind: "$merged" },
            { $sort: { "merged._id": 1 } }
        ]).toArray()
    ]).then(dataArray => {
        // initialize mapping of best networks to Elo rating cached globally
        bestRatings = new Map();

        // prepare networks
        const networks = dataArray[0].map(item => {
            totalgames.count -= item.game_count || 0;

            // The ELF network has games but is not actually best
            const best = item.game_count && !ELF_NETWORKS.some(n => n.startsWith(item.hash));
            if (best)
                bestRatings.set(item.hash, 0);

            return {
                hash: item.hash,
                game_count: item.game_count,
                net: (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count, // mycount
                best
            };
        });

        // prepare ratingsMap
        const ratingsMap = new Map();
        dataArray[1].forEach(match => {
            const network2_rating = ratingsMap.get(match.network2) ? ratingsMap.get(match.network2).rating : 0;
            let sprt;
            let elo;

            // TODO If no Elo info, make rating -1 for graph to just hide it instead of assuming same Elo as network 2.
            //
            if (match.network1_wins > 0 && match.network1_losses > 0) {
                elo = CalculateEloFromPercent(match.network1_wins / match.game_count);
            } else {
                let fakecount = match.game_count;
                let fakewins = match.network1_wins;

                if (fakewins == 0) {
                    fakewins++;
                    fakecount++;
                }

                if (match.network1_losses == 0) {
                    fakecount++;
                }

                elo = CalculateEloFromPercent(fakewins / fakecount);
            }

            // Hide *-vs-ELF test matches as there's no meaningful Elo reference
            if (ELF_NETWORKS.includes(match.network2)) {
                elo = 0;
            }

            const isBest = bestRatings.has(match.network1);
            switch (isBest || SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    sprt = "FAIL";
                    break;

                case true:
                    sprt = "PASS";
                    break;

                default:
                    sprt = "???";
            }

            // Force the match to show up as a test instead of the usual SPRT
            if (match.is_test) {
                sprt = "TEST";
            }

            // Save ratings of best networks
            const rating = elo + network2_rating;
            if (isBest && !match.is_test)
                bestRatings.set(match.network1, rating);

            // Use opponent's net for ELF as its training_count is arbitrary
            const net = ELF_NETWORKS.includes(match.network1) && match.merged.training_count;

            // Chain together previous infos if we have any
            const previous = ratingsMap.get(match.network1);
            const info = { net, previous, rating, sprt };
            ratingsMap.set(match.network1, info);
        });

        // Matches table uses data from bestRatings, so allow it to refresh
        cachematches.del("matches", () => console.log("Cleared match table cache."));

        // prepare json result
        const json = [];
        const addNetworkRating = (item, info = { rating: 0, sprt: "???" }) => {
            const rating = Math.max(0, Math.round(info.rating));
            json.push({
                rating,
                net: Math.max(0.0, Number((info.net || item.net) + rating / 100000)),
                sprt: info.sprt,
                hash: item.hash.slice(0, 6),
                best: item.best && info.sprt !== "TEST"
            });

            // Add additional result for multiple matches
            if (info.previous)
                addNetworkRating(item, info.previous);
        };
        networks.forEach(item => addNetworkRating(item, ratingsMap.get(item.hash)));

        // shortcut for sending json result using `JSON.stringify`
        // and set `Content-Type: application/json`
        return json;
    }).catch(err => {
        console.log("ERROR data/elograph.json: " + err);
        res.send("ERROR data/elograph.json: " + err);
    });
    });

    res.json(json);
}));

app.get("/opening/:start(\\w+)?", asyncMiddleware(async(req, res) => {
    let start = req.params.start;
    const files = {
        44: "top10-Q16.json",
        43: "top10-R16.json",
        33: "top10-R17.json"
    };

    if (!(start in files))
        start = "44";

    const top10 = JSON.parse(fs.readFileSync(path.join(__dirname, "static", files[start])));

    return res.render("opening", { top10, start, menu: "opening" });
}));

app.get("/admin/access-logs", asyncMiddleware(async(req, res) => {
    const url = req.query.url;
    res.render("admin/access-logs", { url });
}));

// Data APIs
app.get("/api/access-logs", asyncMiddleware(async(req, res) => {
    const url = req.query.url;
    const logs = await dbutils.get_access_logs(db, url);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(logs));
}));

app.get("/debug/exception", asyncMiddleware(async() => {
    throw new Error("handler error test" + Date.now());
}));

app.get("/debug/promise", (req, res) => {
    const foo = async() => Promise.reject("Unhandled Exception " + Date.now());
    foo();
    res.send("ok");
});

// Catch all, return 404 page not found
app.get("*", asyncMiddleware(async(req, res) => res.status(404).render("404")));

if (config.RAVEN_DSN) {
    app.use(Raven.errorHandler());
}
