const MongoClient = require('mongodb').MongoClient;
const fs = require("fs");
const zlib = require("zlib");


(async () => {
    try {
        var db = await MongoClient.connect('mongodb://localhost/test');

        // Find networks that didn't have `filters` or `blocks`
        //
        var networks = await db.collection("networks").find(
            {
                $or: [
                    { filters: { $in: [null, 0] } },
                    { blocks: { $in: [null, 0] } },
                ]
            }
        ).toArray();

        console.log(`Found ${networks.length} networks need re-scanning.`)

        var network_folder = __dirname + "/../network/";

        // Start Re-Scanning
        networks.forEach(async network => {
            var network_path = network_folder + network.hash + ".gz";

            if (!fs.existsSync(network_path)) {
                console.log(`Network ${network.hash} not found`);
                return;
            }

            var fileBuffer = fs.readFileSync(network_path);
            var content = zlib.unzipSync(fileBuffer).toString();

            var space = 0, newline = 0;
            for (let x = 0; x < content.length; ++x) {
                var c = content[x];

                if (c == "\n")
                    newline++;
                else if (newline == 2 && c == " ")
                    space++;
            }
            var filters = space + 1, blocks = (newline + 1 - (1 + 4 + 14)) / 8;

            db.collection("networks").updateOne(
                {
                    _id: network._id
                },
                {
                    $set: {
                        filters: filters, blocks: blocks
                    }
                }
            ).then( () => { console.log(`Network ${network.hash} is ${filters}x${blocks} and updated in database`) } );

        });

        db.close();
        console.log("Done");

    } catch (err) {
        console.log(err);
    }
})();
