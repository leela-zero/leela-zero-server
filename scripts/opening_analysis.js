const fs = require("fs-extra");
const path = require("path");
const crypto = require("crypto");
const sgf_parser = require("../classes/sgf_parser");
const MongoClient = require("mongodb").MongoClient;
const request = require("request");

function usage() {
    console.log(
`Usage:
    -h, --help                      Show help
    --extract <all_match.sgf>       Extract sgf
    --analyze                       Analyze sgf
    --export                        Export Result
`);
}

function coord2quadrant2(coord, symmetry) {
    let x = coord.charCodeAt(0) - 65;
    let y = +coord.substr(1);

    if (x < 8) x++;

    x -= 10;
    y -= 10;

    if (x <= 0 && y >= 0) {
        const tmp = x;
        x = y;
        y = -tmp;
    } else if (x <= 0 && y <= 0) {
        x = -x;
        y = -y;
    } else if (x >= 0 && y <= 0) {
        const tmp = x;
        x = -y;
        y = tmp;
    }

    x += 10;
    y += 10;

    if ((y > x && symmetry === null) || symmetry) {
        const tmp = x;
        x = y;
        y = tmp;

        symmetry = true;
    } else if (y < x && symmetry === null) {
        symmetry = false;
    }

    return {
        symmetry,
        coord: String.fromCharCode(x + 64 + (x > 8)) + y
    };
}

async function init() {
    process.argv.shift(); // node
    process.argv.shift(); // opening_analysis.js

    const options = {};

    for (let i = 0; i < process.argv.length; i++) {
        switch (process.argv[i]) {
            case "--extract":
                options.extract = process.argv[++i];
                break;
            case "--analyze":
                options.analyze = true;
                break;
            case "--export":
                options.export = ["Q16", "R16", "R17"];
                break;
            case "--help":
            case "-h":
            default:
                options.help = true;
                break;
        }
    }

    if (options.help) {
        usage();
        return;
    }

    if (options.extract)
        await extract_sgf(options.extract);

    if (options.analyze)
        await analyze_sgf();

    if (options.export)
        await export_result(options.export);
}

async function extract_sgf(all_matches_sgf) {
    const db = await MongoClient.connect("mongodb://localhost/test");

    const file_path = path.join(__dirname, all_matches_sgf);

    if (!fs.pathExistsSync(file_path)) {
        console.error(`sgf file "${file_path}" not found`);
        return;
    }

    const total = await new Promise(resolve => {
        const parser = new sgf_parser({ db });

        fs.createReadStream(file_path)
            .pipe(parser)
            .on("finish", () => resolve(parser.num));
    });

    console.log("Total game #" + total);

    db.close();
}

async function analyze_sgf() {
    const hashes = await new Promise(resolve => {
        request("http://zero.sjeng.org/data/elograph.json", (err, res, body) => {
            const data = JSON.parse(body);
            const hashes = {};

            data.forEach(network => {
                hashes[network.hash] = Math.floor(+network.net);
            });

            resolve(hashes);
        });
    });

    const db = await MongoClient.connect("mongodb://localhost/test");
    const cursor = db.collection("opening").find();
    await db.collection("opening_counts").remove({});

    // Fetch the first object
    let i = 0;
    let obj = null;
    while ((obj = await cursor.nextObject())) {
        for (let j = 0; j < 4; j++) {
            const q = obj["quadrant" + (j + 1)];

            let joseki = "";
            let original = "";
            let symmetry = null;

            for (let k = 0; k < q.length; k++) {
                const result = coord2quadrant2(q[k].coord, symmetry);
                symmetry = result.symmetry;
                joseki += (joseki ? "," : "") + result.coord;
                original += (original ? "," : "") + q[k].coord;

                if (k < 3 || k > 20)
                    continue;

                const _id = crypto.createHash("sha256").update(joseki).digest("hex");
                const $inc = { count: 1 };
                const $addToSet = {};
                const b_training = hashes[obj.B.hash] || 0;
                const w_training = hashes[obj.W.hash] || 0;

                if (b_training > w_training) {
                    $inc["graph." + b_training + ".count"] = 1;
                    $addToSet["graph." + b_training + ".networks"] = obj.B.hash;
                } else if (w_training) {
                    $inc["graph." + w_training + ".count"] = 1;
                    $addToSet["graph." + w_training + ".networks"] = obj.W.hash;
                } else
                    // cannot identify traning #
                    continue;

                await db.collection("opening_counts").updateOne(
                    { _id },
                    {
                        $inc,
                        $set: { joseki },
                        $addToSet
                    },
                    { upsert: true }
                );
            }
        }

        if (i % 10000 == 0) {
            console.log("[" + new Date().toLocaleTimeString() + "][analyze]: game #" + i);
        }
        i++;
    }

    console.log("[" + new Date().toLocaleTimeString() + "][analyze]: game #" + i);
    cursor.close();
    db.close();
}

async function export_result(analysis) {
    const db = await MongoClient.connect("mongodb://localhost/test");
    //let analysis = ["Q16", "R16", "R17"];
    for (const start of analysis) {
        const cursor = db.collection("opening_counts").find({ joseki: new RegExp("^" + start) }).sort({ count: -1 }).limit(1000);
        const top10 = [];
        let obj = null;

        while ((obj = await cursor.nextObject())) {
            const idx = top10.findIndex(x => obj.joseki.startsWith(x.joseki));

            if (idx == -1) {
                top10.push(obj);
            } else if (obj.count * 2 >= top10[idx].count) {
                // if next move is over 50%, we keep exploring
                top10[idx] = obj;
            }
        }

        for (const g of top10) {
            // Simple sgf to display on wgo.js
            g.sgf = "(;SZ[19]" + g.joseki.split(",")
                .map((m, idx) => ";" + (idx % 2 ? "W" : "B") + "[" + String.fromCharCode(m.charCodeAt(0) - 65 + 96) + String.fromCharCode(116 - +m.substr(1)) + "]")
                .join("") + ")";

            // Data for Google Chart
            const chart = [];
            for (const t in g.graph) {
                chart.push([
                    +t,
                    g.graph[t].count,
                    `<p>Training #: ${+t}</p><p>Seen ${g.graph[t].count} times by networks:<p/><ul><li>${g.graph[t].networks.join("</li><li>")}</li></ul></p>`
                ]);
            }
            g.chart = chart;
        }
        fs.writeFileSync(`static/top10-${start}.json`, JSON.stringify(top10.slice(0, 10)));
        cursor.close();
    }

    db.close();
}

(async() => {
    await init();
})();
