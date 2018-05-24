const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const sgf_parser = require('../classes/sgf_parser');
const MongoClient = require('mongodb').MongoClient;
const request = require('request');

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
    var x = coord.charCodeAt(0) - 65,
        y = +coord.substr(1);

    if (x < 8) x++;

    x -= 10;
    y -= 10;

    if (x <= 0 && y >= 0) {
        var tmp = x;
        x = y;
        y = -tmp;
    } else if (x <= 0 && y <= 0) {
        x = -x;
        y = -y;
    } else if (x >= 0 && y <= 0) {
        var tmp = x;
        x = -y;
        y = tmp;

    }

    x += 10;
    y += 10;


    if ((y > x && symmetry === null) || symmetry) {
        var tmp = x;
        x = y;
        y = tmp;

        symmetry = true;
    } else if (y < x && symmetry === null) {
        symmetry = false;
    }


    return {
        symmetry: symmetry,
        coord: String.fromCharCode(x + 64 + (x > 8)) + y
    }
}

async function init() {
    process.argv.shift();   // node
    process.argv.shift();   // opening_analysis.js

    var options = {}, help = false;

    for (var i = 0; i < process.argv.length; i++) {
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
    
    var db = await MongoClient.connect('mongodb://localhost/test');
    
    var file_path = path.join(__dirname, all_matches_sgf);

    if (!fs.pathExistsSync(file_path)) {
        console.error(`sgf file "${file_path}" not found`)
        return;
    }

    var total = await new Promise(resolve => {
        var parser = new sgf_parser({ db: db, collection: "opening_sgf" });

        fs.createReadStream(file_path)
            .pipe(parser)
            .on('finish', () => resolve(parser.num));
    });
    
    console.log('Total game #' + total);

    db.close();
}

async function analyze_sgf() {
    var hashes = await new Promise((resolve, reject) => {
        request('http://zero.sjeng.org/data/elograph.json', (err, res, body) => {
            var data = JSON.parse(body);
            var hashes = {};

            data.forEach(network => {
                hashes[network.hash] = Math.floor(+network.net);
            });

            resolve(hashes);
        });
    });

    var db = await MongoClient.connect('mongodb://localhost/test');
    var cursor = db.collection('opening').find();
    await db.collection("opening_counts").remove({});

    // Fetch the first object
    var i = 0;
    while (obj = await cursor.nextObject()) {

        for (var j = 0; j < 4; j++) {
            var q = obj["quadrant" + (j + 1)];

            var joseki = "",
                symmetry = null,
                original = "";

            for (var k = 0; k < q.length; k++) {
                var result = coord2quadrant2(q[k].coord, symmetry);
                symmetry = result.symmetry;
                joseki += (joseki ? "," : "") + result.coord;
                original += (original ? "," : "") + q[k].coord;

                if (k < 3 || k > 20)
                    continue;

                var _id = crypto.createHash('sha256').update(joseki).digest('hex');
                var $inc = { count: 1 }, $addToSet = {};

                var b_training = hashes[obj.B.hash] || 0;
                var w_training = hashes[obj.W.hash] || 0;

                if (b_training > w_training) {
                    $inc['graph.' + b_training + '.count'] = 1;
                    $addToSet['graph.' + b_training + '.networks'] = obj.B.hash;
                } else if (w_training) {
                    $inc['graph.' + w_training + '.count'] = 1;
                    $addToSet['graph.' + w_training + '.networks'] = obj.W.hash;
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
            console.log('[' + new Date().toLocaleTimeString() + ']: game #' + i);
        }
        i++;
    }

    cursor.close();
}

async function export_result(analysis) {
    var db = await MongoClient.connect('mongodb://localhost/test');
    //var analysis = ["Q16", "R16", "R17"];
    for (let start of analysis) {
        var cursor = db.collection('opening_counts').find({ joseki: new RegExp("^" + start) }).sort({ count: -1 }).limit(1000);
        var top10 = [];

        while (obj = await cursor.nextObject()) {
            var idx = top10.findIndex(x => obj.joseki.startsWith(x.joseki));

            if (idx == -1) {
                top10.push(obj);
            } else if (obj.count * 2 >= top10[idx].count) {
                // if next move is over 50%, we keep exploring
                top10[idx] = obj;
            }
        }

        for (let g of top10) {
            // Simple sgf to display on wgo.js
            g.sgf = "(;SZ[19]" + g.joseki.split(',').map((m, idx) => {
                return ";" + (idx % 2 ? "W" : "B")
                    + "[" + String.fromCharCode(m.charCodeAt(0) - 65 + 96) + String.fromCharCode(116 - +m.substr(1)) + "]";
            }).join("") + ")";

            // Data for Google Chart
            var chart = [];
            for (var t in g.graph) {
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

(async () => {
    await init();
})();


