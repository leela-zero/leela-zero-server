const moment = require('moment');
const express = require('express');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs-extra');
const MongoClient = require('mongodb').MongoClient;
const Long = require('mongodb').Long;
const ObjectId = require('mongodb').ObjectID;
const safeObjectId = s => ObjectId.isValid(s) ? new ObjectId(s) : null;
const zlib = require('zlib');
const converter = require('hex2dec');
const Cacheman = require('cacheman');
const AsyncLock = require('async-lock');

const app = express();

var lock = new AsyncLock();

var auth_key = String(fs.readFileSync(__dirname + "/auth_key")).trim();

var cacheIP24hr = new Cacheman('IP24hr');
var cacheIP1hr = new Cacheman('IP1hr');
var cachematches = new Cacheman('matches');

var fastClientsMap = new Map;

app.set('view engine', 'pug')

// This shouldn't be needed but now and then when I restart test server, I see an uncaught ECONNRESET and I'm not sure
// where it is coming from. In case a server restart did the same thing, this should prevent a crash that would stop nodemon.
//
// It was a bug in nodemon which has now been fixed. It is bad practice to leave this here, eventually remove it.
//
process.on('uncaughtException', (err) => {
    console.error('Caught exception: ' + err);
});

// https://blog.tompawlak.org/measure-execution-time-nodejs-javascript

var counter;
var best_network_hash = null;
var best_network_mtimeMs = 0;
var db;

// TODO Make a map to store pending match info, use mapReduce to find who to serve out, only 
// delete when SPRT fail or needed games have all arrived? Then we can update stats easily on
// all matches except just the current one (end of queue).
//
var pending_matches = [];
var MATCH_EXPIRE_TIME = 30 * 60 * 1000; // matches expire after 30 minutes. After that the match will be lost and an extra request will be made.

const SI_PREFIXES = ["", "k", "M", "G", "T", "P", "E"];

// From https://stackoverflow.com/questions/9461621/how-to-format-a-number-as-2-5k-if-a-thousand-or-more-otherwise-900-in-javascrip
//
function abbreviateNumber(number, length) {
    // what tier? (determines SI prefix)
    var tier = Math.log10(number) / 3 | 0;

    // if zero, we don't need a prefix
    if(tier == 0) return number;

    // get prefix and determine scale
    var prefix = SI_PREFIXES[tier];
    var scale = Math.pow(10, tier * 3);

    // scale the number
    var scaled = number / scale;

    // format number and add prefix as suffix
    return scaled.toPrecision(length) + prefix;
}

function CalculateEloFromPercent(percentage) {
    return -400 * Math.log(1 / percentage - 1) / Math.LN10;
}

function checksum (str, algorithm, encoding) {
    return crypto
        .createHash(algorithm || 'md5')
        .update(str, 'utf8')
        .digest(encoding || 'hex')
}

function seed_from_mongolong (seed) {
    return converter.hexToDec(
        "0x"
        + (new Uint32Array([seed.getHighBits()]))[0].toString(16)
        + (new Uint32Array([seed.getLowBits()]))[0].toString(16).padStart(8, "0")
        ).toString();
}

//console.log("Small int test 777: " + seed_from_mongolong(Long.fromString("777", 10)));
//console.log("Broken int test 883863265504794200: " + seed_from_mongolong(Long.fromString("883863265504794200", 10)));

function objectIdFromDate (date) {
    //return Math.floor(date.getTime() / 1000).toString(16) + "0000000000000000";
    return safeObjectId( Math.floor(date / 1000).toString(16) + "0000000000000000" );
}

// This comes from https://medium.com/@Abazhenov/using-async-await-in-express-with-node-8-b8af872c0016
//
const asyncMiddleware = fn =>
    (req, res, next) => {
        Promise.resolve(fn(req, res, next))
            .catch(next);
};

function get_options_hash (options) {
    if (options.visits) {
        return checksum("" + options.visits + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
    } else {
        return checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
    }
};

async function get_fast_clients () {
    return new Promise( (resolve, reject) => {
        db.collection("games").aggregate( [
            { $match: { _id: { $gt: objectIdFromDate(Date.now() - 1000 * 60 * 60)}}},
            { $group: { _id: "$ip", total: { $sum: 1 }}},
            { $match: { total: { $gt: 4 }}}
        ] ).forEach( (match) => {
            fastClientsMap.set(match._id, true);
        }, (err) => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });

        resolve();
    });
};

//  db.matches.aggregate( [ { "$redact": { "$cond": [ { "$gt": [ "$number_to_play", "$game_count" ] }, "$$KEEP", "$$PRUNE" ] } } ] )
//
async function get_pending_matches () {
    pending_matches = [];

    return new Promise( (resolve, reject) => {
        db.collection("matches").aggregate( [
            { "$redact": { "$cond":
                [
                    { "$gt": [ "$number_to_play", "$game_count" ] },
                    "$$KEEP", "$$PRUNE"
                ] } }
        ] ).sort({_id:-1}).forEach( (match) => {
            match.requests = []; // init request list.
            
            // Client only accepts strings for now
            //
            Object.keys(match.options).map( (key, index) => {
                match.options[key] = String(match.options[key]);
            });

            // If SPRT=pass use unshift() instead of push() so "elo only" matches go last in priority
            //
            switch(SPRT(match.network1_wins, match.network1_losses)) {
                case false:
                    break;
                case true:
                    pending_matches.unshift( match );
                    console.log("SPRT: Unshifting: " + JSON.stringify(match));
                    break;
                default:
                    pending_matches.push( match );
                    console.log("SPRT: Pushing: " + JSON.stringify(match));
            }
        }, (err) => {
            if (err) {
                console.error("Error fetching matches: " + err);
                return reject(err);
            }
        });

        resolve();
    });
};

async function get_best_network_hash () {
    return new Promise( (resolve, reject) => {
        // Check if file has changed. If not, send casched version instead.
        //
      console.log("LOCK requested get_best_network_hash");
      lock.acquire("hash", () => {
        console.log("LOCK acquired get_best_network_hash");
        fs.stat(__dirname + '/network/best-network.gz', (err, stats) => {
            if (err) return reject(err);

            if (!best_network_hash || best_network_mtimeMs != stats.mtimeMs) {
                console.log("best-network.gz has changed");
                fs.readFile(__dirname + '/network/best-network.gz', (err, data) => {
                    if (err) {
                        console.error("Error opening best-network.gz: " + err);
                        return reject(err);
                    }

                    var networkbuffer = Buffer.from(data);

                    console.log("Begin zlib.unzip");
                    zlib.unzip(networkbuffer, (err, networkbuffer) => {
                        console.log("End zlib.unzip");
                        if (err) {
                            console.error("Error decompressing best-network.gz: " + err);
                            return reject(err);
                        } else {
                            var network = networkbuffer.toString();
                            best_network_hash = checksum(network, 'sha256');
                            best_network_mtimeMs = stats.mtimeMs;
                            resolve( best_network_hash );
                        }
                    });
                });
            } else {
                resolve( best_network_hash );
            }
        });
      });
    });
};

//SPRT
//
function LL (x) {
    return 1/(1+10**(-x/400));
}

function LLR(W, L, elo0, elo1) {
    //if (W==0 || L==0) return 0;
    if (!W) W=1;
    if (!L) L=1;

    var N = W + L;
    var w = W/N, l = L/N;
    var s = w;
    var m2 = w;
    var variance = m2-s**2;
    var variance_s = variance / N;
    var s0 = LL(elo0);
    var s1 = LL(elo1);

    return (s1-s0)*(2*s-s0-s1)/variance_s/2.0;
}

//function SPRTold(W,L,elo0,elo1)
function SPRTold(W,L)
{
    var elo0 = 0, elo1 = 35;
    var alpha = .05, beta = .05;

    var LLR_ = LLR(W,L,elo0,elo1);
    var LA = Math.log(beta/(1-alpha));
    var LB = Math.log((1-beta)/alpha);

    if (LLR_ > LB && W + L > 100) {
        return true;
    } else if (LLR_ < LA) {
        return false;
    } else {
        return null;
    }
}

function stDev(n) {
  return Math.sqrt(n/4);
}

function canReachLimit(w, l, max, aim) {
  var aimPerc = aim/max;
  var remaining = max-w-l;
  var expected = remaining*aimPerc;
  var maxExpected = expected+3*stDev(remaining)
  var needed = aim-w;
  return maxExpected>needed;
}

function SPRT(w, l) {
  var max = 400;
  var aim = max / 2 + 2 * stDev(max);
  if(w+l>=max&&w/(w+l)>=(aim/max)) return true;
  if (!canReachLimit(w, l, max, aim)) return false;
  return SPRTold(w,l);
}

var QUEUE_BUFFER = 25;
var PESSIMISTIC_RATE = 0.2;

function how_many_games_to_queue(max_games, w_obs, l_obs, pessimistic_rate) {
    var games_left = max_games - w_obs - l_obs;

    if (SPRT(w_obs, l_obs) === true) {
        return games_left + QUEUE_BUFFER;
    }

    if (SPRT(w_obs, l_obs) === false) {
        return 0;
    }

    for (var queued_games=0; queued_games < games_left; queued_games++) {
        if (SPRT(w_obs+queued_games*pessimistic_rate, l_obs+queued_games*(1-pessimistic_rate)) === false) {
            return queued_games + QUEUE_BUFFER;
        }
    }

    return games_left + QUEUE_BUFFER;
}

app.enable('trust proxy');

app.use(bodyParser.urlencoded({extended: true}));
app.use(fileUpload());

app.use('/view/player', express.static('eidogo-player-1.2/player'));
app.use('/viewmatch/player', express.static('eidogo-player-1.2/player'));
app.use('/view/wgo', express.static('wgo'));
app.use('/viewmatch/wgo', express.static('wgo'));
app.use('/static', express.static('static'));

// This is async but we don't need it to start the server. I'm calling it during startup so it'll get the value cached right away
// instead of when the first /best-network request comes in, in case a lot of those requests come in at once when server
// starts up.
get_best_network_hash().then( (hash) => console.log("Current best hash " + hash) );

setInterval( () => {
    get_fast_clients()
    .then()
    .catch();
}, 1000 * 60 * 10);

var last_match_db_check = Date.now();

setInterval( () => {
    var now = Date.now();

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

MongoClient.connect('mongodb://localhost/test', (err, database) => {
    if (err) return console.log(err);

    db = database;

    db.collection("networks").count()
    .then((count) => {
        console.log ( count + " networks.");
    });

    db.collection("networks").aggregate( [
        {
            $group: {
                _id: null,
                total: { $sum: "$game_count" }
            }
        }
    ], (err, res) => {
        if (err) console.log( err );

        get_fast_clients()
        .then()
        .catch();

        get_pending_matches()
        .then()
        .catch();

        counter =  res[0] && res[0].total;
        console.log ( counter + " games.");

        app.listen(8080, () => {
            console.log('listening on 8080')
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
app.use('/best-network-hash', asyncMiddleware( async (req, res, next) => {
    var hash = await get_best_network_hash();

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
app.use('/best-network', asyncMiddleware( async (req, res, next) => {
    var hash = await get_best_network_hash();
    var readStream = fs.createReadStream(__dirname + '/network/best-network.gz');

    readStream.on('error', (err) => {
        res.send("Error: " + err);
        console.error("ERROR /best-network : " + err);
    });

    readStream.on('open', () => { 
        res.setHeader('Content-Disposition', 'attachment; filename=' + hash + ".gz");
        res.setHeader('Content-Transfer-Encoding', 'binary');
        res.setHeader('Content-Type', 'application/octet-stream');
    });

    readStream.pipe(res);

    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " downloaded /best-network");
}));

app.post('/request-match', (req, res) => {
    // "number_to_play" : 400, "options" : { "playouts" : 1600, "resignation_percent" : 1, "randomcnt" : 0, "noise" : "false" }

    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }
 
    if (!req.body.network1)
        return res.status(400).send('No network1 hash specified.');

    if (!req.body.network2)
        req.body.network2 = null;

    // TODO Need to support new --visits flag as an alternative to --playouts. Use visits if both are missing? Don't allow both to be set.
    //
    if (req.body.playouts && req.body.visits)
        return res.status(400).send('Please set only playouts or visits, not both');

    if (!req.body.playouts && !req.body.visits)
        //req.body.playouts = 1600;
        req.body.visits = 3200;
        //return res.status(400).send('No playouts specified.');

    if (!req.body.resignation_percent)
        req.body.resignation_percent = 10;
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

    var options = { "resignation_percent": Number(req.body.resignation_percent),
        "randomcnt": Number(req.body.randomcnt),
        "noise": String(req.body.noise) };

    if (req.body.playouts) {
        options.playouts = Number(req.body.playouts);
    } 

    if (req.body.visits) {
        options.visits = Number(req.body.visits);
    } 

    var match = { "network1": req.body.network1,
        "network2": req.body.network2, "network1_losses": 0,
        "network1_wins": 0,
        "game_count": 0, "number_to_play": Number(req.body.number_to_play),
        "options": options, "options_hash": get_options_hash(options) };

    db.collection("matches").insertOne( match )
    .then( () => {
        // Client only accepts strings for now
        Object.keys(match.options).map( (key, index) => {
            match.options[key] = String(match.options[key]);
        });

        match.requests = []; // init request list.
        pending_matches.unshift( match );

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " Match added!");
        res.send("Match added!\n");
        console.log("Pending is now: " + JSON.stringify(pending_matches));
    } )
    .catch( (err) => {
        console.error(req.ip + " (" + req.headers['x-real-ip'] + ") " + " ERROR: Match addition failed: " + err);
        res.send("ERROR: Match addition failed\n");
    } );
});

// curl -F 'weights=@zero.prototxt' -F 'training_count=175000' http://localhost:8080/submit-network
//
// Detect if network already exists and if so, inform the uploader and don't overwrite?
// So we don't think the network is newer than it really is. Actually, upsert shouldn't change
// the ObjectID so date will remain original insertion date.
//
app.post('/submit-network', asyncMiddleware( async (req, res, next) => {
    if (!req.body.key || req.body.key != auth_key) {
        console.log("AUTH FAIL: '" + String(req.body.key) + "' VS '" + String(auth_key) + "'");

        return res.status(400).send('Incorrect key provided.');
    }
 
    if (!req.files)
        return res.status(400).send('No weights file was uploaded.');

    var network;
    var hash;
    var networkbuffer = Buffer.from(req.files.weights.data);

    zlib.unzip(networkbuffer,  asyncMiddleware( async (err, networkbuffer, next) => {
        if (err) {
            console.error("Error decompressing network: " + err);
            res.send("Error decompressing network: " + err);
        } else {
            network = networkbuffer.toString();
            hash = checksum(network, 'sha256');

            var training_count;

            if (!req.body.training_count) {
                var cursor = db.collection("networks").aggregate( [ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
                var totalgames = await cursor.next();

                training_count = totalgames.count;
            } else {
                training_count = Number(req.body.training_count);
            }

            var training_steps = req.body.training_steps ? Number(req.body.training_steps) : null;

            db.collection("networks").updateOne(
                { hash: hash },
                // Weights data is too large, store on disk and just store hashes in the database?
                //
                { $set: { hash: hash, ip: req.ip, training_count: training_count, training_steps: training_steps }}, { upsert: true },
                (err, dbres) => {
                    // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                    //
                    if (err) {
                        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded network " + hash + " ERROR: " + err);
                    } else {
                        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded network " + hash + " (" + training_count + ")");
                    }
            });

            // If we serve a listing from database instead and query as needed, this can be removed.
            //
            var networkpath = __dirname + '/network/';

            fs.mkdirs(networkpath)
            .then(() => {
                fs.pathExists(networkpath + hash + ".gz")
                .then(exists => {
                    if (!exists) {
                        req.files.weights.mv(networkpath + hash + ".gz", (err) => {
                            if (err)
                                return res.status(500).send(err);
        
                            console.log('Network weights ' + hash + " (" + training_count + ")" + ' uploaded!');
                            res.send('Network weights ' + hash + " (" + training_count + ")" + ' uploaded!\n');
                        })
                    } else {
                        console.log('Network weights ' + hash + ' already exists.');
                        res.send('Network weights ' + hash + ' already exists.\n');
                    }
                })
            })
            .catch(err => {
                console.error("Cannot make directory error: " + err)
            });
        }
    }));
}));

app.post('/submit-match',  asyncMiddleware( async (req, res, next) => {
    if (!req.files) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No files were uploaded.');
        return res.status(400).send('No files were uploaded.');
    }

    if (!req.files.sgf) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No sgf file provided.');
        return res.status(400).send('No sgf file provided.');
    }

    if (!req.body.clientversion) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No clientversion specified.');
        return res.status(400).send('No clientversion specified.');
    }

    if (!req.body.winnerhash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No winnerhash (network hash for winner) specified.');
        return res.status(400).send('No winnerhash (network hash for winner) specified.');
    }

    if (!req.body.loserhash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No loserhash (network hash for loser) specified.');
        return res.status(400).send('No loserhash (network hash for loser) specified.');
    }

    if (!req.body.winnercolor) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No winnercolor provided.');
        return res.status(400).send('No winnercolor provided.');
    }

    if (!req.body.movescount) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No movescount provided.');
    }

    if (!req.body.score) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No score provided.');
        return res.status(400).send('No score provided.');
    }

    if (!req.body.options_hash) {
        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + '/submit-match: No options_hash provided.');
        return res.status(400).send('No options_hash provided.');
    }

    if (!req.body.random_seed) {
        req.body.random_seed = null;
    } else {
        req.body.random_seed = Long.fromString(req.body.random_seed, 10);   
    }

    var best_network_hash = await get_best_network_hash();
    var new_best_network_flag = false;
    var sgfbuffer = Buffer.from(req.files.sgf.data);

    zlib.unzip(sgfbuffer, (err, sgfbuffer) => {
      if (err) {
        console.error("Error decompressing sgffile in /submit-match: " + err);
      } else {
        var sgffile = sgfbuffer.toString();
        var sgfhash = checksum(sgffile, 'sha256');

        db.collection("match_games").updateOne(
            { sgfhash: sgfhash },
            { $set: { ip: req.ip, winnerhash: req.body.winnerhash, loserhash: req.body.loserhash, sgf: sgffile,
                      options_hash: req.body.options_hash,
                      clientversion: Number(req.body.clientversion), winnercolor: req.body.winnercolor,
                      movescount: (req.body.movescount ? Number(req.body.movescount) : null),
                      score: req.body.score,
                      random_seed: req.body.random_seed
                    }}, 
            { upsert: true },
            (err, dbres) => {
                // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                //
                if (err) {
                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded match " + sgfhash + " ERROR: " + err);
                    res.send("Match data " + sgfhash + " stored in database\n");
                } else {
                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded match " + sgfhash);
                    res.send("Match data " + sgfhash + " stored in database\n");
                }
            }
        );

        // TODO: Check dbres above to see if it was a duplicate, if possible? Then don't update stats below if so.
        //
        db.collection("matches").updateOne(
            { network1: req.body.winnerhash, network2: req.body.loserhash, options_hash: req.body.options_hash },
            { $inc: { network1_wins: 1, game_count: 1 } },
            { },
            (err, dbres) => {
                if (err) {
                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded match " + sgfhash + " INCREMENT ERROR: " + err);
                } else {
                    pending_matches
                      .filter(e => ((e.network1 === req.body.winnerhash && e.network2 === req.body.loserhash) ||
                                    (e.network2 === req.body.winnerhash && e.network1 === req.body.loserhash)) &&
                                     e.options_hash === req.body.options_hash)
                      .forEach(match => {
                        var index = match.requests.findIndex(e => e.seed === seed_from_mongolong(req.body.random_seed));
                        if (index !== -1) {
                          match.requests.splice(index, 1); // remove the match from the requests array.
                        }
                        match.game_count++;
                      })
                    if (dbres.modifiedCount == 0) {
                        db.collection("matches").updateOne(
                            { network1: req.body.loserhash, network2: req.body.winnerhash, options_hash: req.body.options_hash },
                            { $inc: { network1_losses: 1, game_count: 1 } },
                            { },
                            (err, dbres) => {
                                if (err) {
                                    console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded match " + sgfhash + " INCREMENT ERROR: " + err);
                                } else {
                                    if (dbres.modifiedCount == 0) {
                                        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " ERROR: No match found to update from " + JSON.stringify(req.body));
                                    } else {
                                        // network1 was the loser
                                        if (pending_matches.length &&
                                            pending_matches[pending_matches.length - 1].network1 == req.body.loserhash &&
                                            pending_matches[pending_matches.length - 1].network2 == req.body.winnerhash &&
                                            pending_matches[pending_matches.length - 1].options_hash == req.body.options_hash)
                                        {
                                            pending_matches[pending_matches.length - 1].network1_losses++;

                                            // Adding a loss might make us fail SPRT
                                            //
                                            if (SPRT(pending_matches[pending_matches.length - 1].network1_wins, 
                                                    pending_matches[pending_matches.length - 1].network1_losses) === false)
                                            {
                                                console.log("SPRT: Early fail pop: " + JSON.stringify(pending_matches[pending_matches.length - 1]));
                                                pending_matches.pop();
                                            }
                                        }
                                    }
                                }
                            }
                        );
                    } else {
                        // network1 was the winner
                        if (pending_matches.length &&
                            pending_matches[pending_matches.length - 1].network1 == req.body.winnerhash &&
                            pending_matches[pending_matches.length - 1].network2 == req.body.loserhash &&
                            pending_matches[pending_matches.length - 1].options_hash == req.body.options_hash)
                        {
                            pending_matches[pending_matches.length - 1].network1_wins++;

                            // Adding a win might make us pass SPRT.
                            //
                            //if (pending_matches.length > 1 &&
                            if (SPRT(pending_matches[pending_matches.length - 1].network1_wins, 
                                     pending_matches[pending_matches.length - 1].network1_losses) === true)
                            {
                                // Check > 1 since we'll run to 400 even on a SPRT pass, but will do it at end.
                                //
                                if (pending_matches.length > 1)
                                {
                                    console.log("SPRT: Early pass unshift: "
                                        + JSON.stringify(pending_matches[pending_matches.length - 1]));
                                    pending_matches.unshift( pending_matches.pop() );
                                }

                                // Now, if we are playing vs best_network_hash and we have SPRT pass, promote new network.
                                //
                                // Actually if we do async functions in here, we might pop wrong stuff off the queue. Better to just check
                                // at the end and not try to reduce database lookups?
                                //
                                // Ok new problem, during the async stuff later more requests come in and so network2=null matches
                                // don't face right opponent. Lets do a sync copy if this was in fact a new best network
                                // situation for the current active match in queue.
                                //
                                if (req.body.loserhash == best_network_hash) {
                                    new_best_network_flag = true;

                                    fs.copyFileSync(__dirname + '/network/' + req.body.winnerhash + '.gz', __dirname + '/network/best-network.gz');
                                    console.log("New best network copied from (fast check): " + __dirname + '/network/' + req.body.winnerhash + '.gz');
                                }
                            }
                        } else {
                            // network1 was the winner but it was no longer at the end of the pending_match queue.
                            //
                        }
                    }
                }
            }
        );
      }
    });

    // Check if network2 == best_network_hash and if so, check SPRT. If SPRT pass, promote network1 as new best-network.
    // This is for the case where a match comes in to promote us, after it is no longer the active match in queue.
    //
    if (!new_best_network_flag && req.body.loserhash == best_network_hash) {
        db.collection("matches").findOne({ network1: req.body.winnerhash, network2: best_network_hash, options_hash: req.body.options_hash})
        .then( (match) => { 
            if (match && ( (SPRT(match.network1_wins, match.network1_losses) === true) || (match.game_count >= 400 && match.network1_wins / match.game_count >= 0.55) ) ) {
                fs.copyFileSync(__dirname + '/network/' + req.body.winnerhash + '.gz', __dirname + '/network/best-network.gz');
                console.log("New best network copied from (normal check): " + __dirname + '/network/' + req.body.winnerhash + '.gz');
            }
        }).catch( err => {
            console.log("ERROR: " + req.body.winnerhash + " " + best_network_hash + " " + req.body.options_hash);
            console.log("ERROR: Couldn't check for new best network: " + err);
        });
    }

    cachematches.clear( () => { console.log("Cleared match cache."); } );
}));

// curl -F 'networkhash=abc123' -F 'file=@zero.prototxt' http://localhost:8080/submit
// curl -F 'networkhash=abc123' -F 'sgf=@zero.prototxt' -F 'trainingdata=@zero.prototxt' http://localhost:8080/submit

app.post('/submit', (req, res) => {
    if (!req.files)
        return res.status(400).send('No files were uploaded.');

    if (!req.body.networkhash)
        return res.status(400).send('No network hash specified.');

    if (!req.files.sgf)
        return res.status(400).send('No sgf file provided.');

    if (!req.files.trainingdata)
        return res.status(400).send('No trainingdata file provided.');

    if (!req.body.random_seed) {
        req.body.random_seed = null;
    } else {
        req.body.random_seed = Long.fromString(req.body.random_seed, 10);
    }

    let clientversion;

    if (!req.body.clientversion) {
    	clientversion = 0;
    } else {
    	clientversion = req.body.clientversion;
    }
    
    var networkhash = req.body.networkhash;
    var trainingdatafile;
    var sgffile;
    var sgfhash;

    var sgfbuffer = Buffer.from(req.files.sgf.data);
    var trainbuffer = Buffer.from(req.files.trainingdata.data);

    if (req.ip == "xxx") {
        res.send("Game data " + sgfhash + " stored in database\n");
        console.log("FAKE/SPAM reply sent to " + "xxx" + " (" + req.headers['x-real-ip'] + ")");
    } else {

    zlib.unzip(sgfbuffer, (err, sgfbuffer) => {
        if (err) {
            console.error("Error decompressing sgffile: " + err);
        } else { 
            sgffile = sgfbuffer.toString();
            sgfhash = checksum(sgffile, 'sha256');

            zlib.unzip(trainbuffer, (err, trainbuffer) => {
                if (err) {
                    console.error("Error decompressing trainingdata: " + err);
                } else {
                    trainingdatafile = trainbuffer.toString();

                    db.collection("games").updateOne(
                        { sgfhash: sgfhash },
                        { $set: { ip: req.ip, networkhash: networkhash, sgf: sgffile, options_hash: req.body.options_hash,
                                    movescount: (req.body.movescount ? Number(req.body.movescount) : null),
   			                        data: trainingdatafile, clientversion: Number(clientversion),
                                    winnercolor: req.body.winnercolor, random_seed: req.body.random_seed }}, 
			            { upsert: true },
                        (err, dbres) => {
                            // Need to catch this better perhaps? Although an error here really is totally unexpected/critical.
                            //
                            if (err) {
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash + " ERROR: " + err);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            } else {
                                counter++;
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash);
                                res.send("Game data " + sgfhash + " stored in database\n");
                            }
                        }
                    );

                    db.collection("networks").updateOne(
                        { hash: networkhash },
                        { $inc: { game_count: 1 } },
                        { },
                        (err, dbres) => {
                            if (err) {
                                console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " uploaded game #" + counter + ": " + sgfhash + " INCREMENT ERROR: " + err);
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

app.get('/',  asyncMiddleware( async (req, res, next) => {
    console.log(req.ip + " Sending index.html");

    var network_table = "<table class=\"networks-table\" border=1><tr><th colspan=5>Best Network Hash</th></tr>\n";
    network_table += "<tr><th>#</th><th>Upload Date</th><th>Hash</th><th>Games</th><th>Training #</th></tr>\n";

    var styles = "";
    var iprecentselfplayhash = "";
    var mostrecentselfplayhash = "";

    var cursor = db.collection("networks").aggregate( [ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    var totalgames = await cursor.next();

    var best_network_hash = await get_best_network_hash();

    Promise.all([
        cacheIP24hr.wrap('IP24hr', '5m', () => { return Promise.resolve(
        db.collection("games").distinct('ip', { _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } })
        )})
        .then((list) => { 
            return (list.length + " clients in past 24 hours, ");
        }),
        cacheIP1hr.wrap('IP1hr', '30s', () => { return Promise.resolve(
        db.collection("games").distinct('ip', { _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } })
        )})
        .then((list) => { 
            return (list.length + " in past hour.<br>");
        }),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } }).count()
        .then((count) => { 
            return (counter + " total selfplay games. (" + count + " in past 24 hours, ");
        }),
        db.collection("games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } }).count()
        .then((count) => { 
            return (count + " in past hour.)<br>");
        }),
        db.collection("match_games").find().count()
        .then((count) => { 
            return (count + " total match games. (");
        }),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60 * 24) } }).count()
        .then((count) => { 
            return (count + " match games in past 24 hours, ");
        }),
        db.collection("match_games").find({ _id: { $gt: objectIdFromDate(Date.now()- 1000 * 60 * 60) } }).count()
        .then((count) => { 
            return (count + " in past hour.)<br>");
        }),
        db.collection("networks").aggregate( [ { $match: { game_count: { $gt: 0 } } }, { $group: { _id: 1, networks: { $push: { _id: "$_id", hash: "$hash", game_count: "$game_count", training_count: "$training_count" } } } }, {$unwind: {path: '$networks', includeArrayIndex: 'networkID'}}, { $project: { _id: "$networks._id", hash: "$networks.hash", game_count: "$networks.game_count", training_count: "$networks.training_count", networkID: 1 } }, { $sort: { networkID: -1 } }, { $limit: 10000 }] )
        //db.collection("networks").find({ game_count: { $gt: 0 } }, { _id: 1, hash: 1, game_count: 1, training_count: 1}).sort( { _id: -1 } ).limit(100)
        .toArray()
        .then((list) => { 
            for (let item of list) {
                var itemmoment = new moment(item._id.getTimestamp());

                totalgames.count -= item.game_count;

                network_table += "<tr><td>" 
                    + item.networkID
                    + "</td><td>"
                    + itemmoment.format("YYYY-MM-DD HH:mm")
                    + "</td><td><a href=\"/networks/"
                    + item.hash
                    + ".gz\">"
                    + item.hash.slice(0,8)
                    + "</a></td><td>"
                    + item.game_count
                    + "</td><td>"
                    + ( (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count)
                    + "</td></tr>\n";
            } 

            network_table += "</table>\n";
            return "";
        }),
        db.collection("games").find({ ip: req.ip }, { _id: 0, sgfhash: 1 }).hint( "ip_-1__id_-1" ).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => { 
            if (game[0]) {
                iprecentselfplayhash = game[0].sgfhash;
            }

            return "";
        }),
        db.collection("match_games").find(
            { winnerhash: best_network_hash },
            { _id: 0, winnerhash: 1, loserhash: 1, sgfhash: 1 }
        ).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => { 
            if (game[0]) {
                return "<br>"
                    + "View most recent match win by best network " + game[0].winnerhash.slice(0,8) + " vs " + game[0].loserhash.slice(0,8) + ": "
                    + "[<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=eidogo\">EidoGo</a> / "
                    + "<a href=\"/viewmatch/" + game[0].sgfhash + "?viewer=wgo\">WGo</a>] "
                    + "<br>";
            } else { 
                return "";  
            }
        }),
        db.collection("games").find({}, { _id: 0, sgfhash: 1 }).sort( { _id: -1 } ).limit(1).toArray()
        .then((game) => { 
            if (game[0]) {
                mostrecentselfplayhash = game[0].sgfhash;
            }

            return "";
        }),
        cachematches.wrap('matches', '1d', () => { return Promise.resolve(
        db.collection("matches").aggregate([ { "$lookup": { "localField": "network2", "from": "networks", "foreignField": "hash", "as": "merged" } }, { "$unwind": "$merged" }, { "$lookup": { "localField": "network1", "from": "networks", "foreignField": "hash", "as": "merged1" } }, { "$unwind": "$merged1" }, { "$sort": { "merged.training_count": -1, _id: -1 } }, { "$limit": 100 } ])
        .toArray()
        .then((list) => {
            var match_table = "<table class=\"matches-table\" border=1><tr><th colspan=5>Test Matches (100 Most Recent)</th></tr>\n";
            match_table += "<tr><th>Start Date</th><th>Network Hashes</th><th>Wins / Losses</th><th>Games</th><th>SPRT</th></tr>\n";

            for (let item of list) {
                // The aggregate query above should not return any null network2 matches, but let's be safe.
                //
                if (item.network2 === null) continue;

                var win_percent = item.game_count ? (100 * item.network1_wins / item.game_count).toFixed(2) : null;
                var itemmoment = new moment(item._id.getTimestamp());

                if (win_percent) {
                    if (win_percent >= 55) {
                        win_percent = "<b>" + win_percent + "</b>";
                    }
                    win_percent = " (" + win_percent + "%)";
                }

                match_table += "<tr>"
                    + "<td>" + itemmoment.format("YYYY-MM-DD HH:mm") + "</td>"
                    + "<td>"
                    + "<div class=\"tooltip\">"
                    + "<a href=\"/networks/" + item.network1 + ".gz\">" + item.network1.slice(0,8) + "</a>"
                    + "<span class=\"tooltiptextleft\">"
                    + abbreviateNumber(item.merged1.training_count, 4)
                    + (item.merged1.training_steps ? "+" + abbreviateNumber(item.merged1.training_steps, 3) : "")
                    + "</span></div>"
                    + " <a href=\"/match-games/" + item._id + "\">VS</a> ";

                if (item.network2) {
                    match_table += "<div class=\"tooltip\">"
                        + "<a href=\"/networks/" + item.network2 + ".gz\">" + item.network2.slice(0,8) + "</a>"
                        + "<span class=\"tooltiptextright\">"
                        + abbreviateNumber(item.merged.training_count, 4)
                        + (item.merged.training_steps ? "+" + abbreviateNumber(item.merged.training_steps, 3) : "")
                        + "</span></div>"
                } else {
                    match_table += "BEST";
                }

                match_table += "</td>"
                    + "<td>" + item.network1_wins + " : " + item.network1_losses +
                        ( win_percent ? win_percent + "</td>" : "</td>")
                    + "<td>" + item.game_count + " / " + item.number_to_play + "</td>"
                    + "<td>";

                switch(SPRT(item.network1_wins, item.network1_losses)) {
                    case true:
                        match_table += "<b>PASS</b>";
                        break;
                    case false:
                        match_table += "<i>fail</i>";
                        break;
                    default:
                        // -2.9444389791664403 2.9444389791664403 == range of 5.88887795833
                        var width = Math.round(100 * (2.9444389791664403 + LLR(item.network1_wins, item.network1_losses, 0, 35)) / 5.88887795833);
                        var color;

                        if (width < 0) {
                            color = "C11B17";
                            width = 0;
                        } else if (width > 100) {
                            color = "0000FF";
                            width = 100;
                        } else {
                            color = "59E817";
                        }

                        styles += ".n" + item.network1.slice(0,8) + "{ width: " + width + "%; background-color: #" + color + ";}\n";
                        match_table += "<div class=\"n" + item.network1.slice(0,8) + "\">&nbsp;</div>";
                }

                match_table += "</td></tr>\n";
            } 

            match_table += "</table>\n";
            return [styles, match_table];
        })
        )}),
    ]).then((responses) => {
        var match_and_styles = responses.pop();

        var styles = match_and_styles[0];
        var match_table = match_and_styles[1];

        var page = "<html><head>\n<title>Leela Zero</title>\n";
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
        page += "<br>Network 6615567e is a net2net trained 10x128 network test. Not a bug. <a href=\"https://github.com/gcp/leela-zero/issues/965\">Info here</a>.<br>\n";
        page += "Network 1e2b85cf is best_v1 tested as a reference point. It isn't a normal LZ network. Not a bug.<br>\n";
        page += "<br>Autogtp will automatically download better networks once found.<br>";
        page += "Not each trained network will be a strength improvement over the prior one. Patience please. :)<br>";
        page += "Match games are played at full strength (only 3200 visits).<br>";
        page += "Training games are played with some randomness in first 30 moves, and noise all game long.<br>";
        page += "<br>";
        page += "2018-03-05 We moved to 10 blocks x 128 filters.<br>";
        page += "2018-02-19 <a href=\"https://github.com/gcp/leela-zero/releases\">Leela Zero 0.12 + AutoGTP v14</a>. <b>Update required.</b><br>";
        page += "2018-01-20 We moved to 6 blocks x 128 filters.<br>";
        page += "2017-11-21 We moved to 5 blocks x 64 filters.<br>";
        page += "<br>";

        responses.map( response => page += response );

        if (mostrecentselfplayhash) {
            page += "View most recent selfplay training game: ";
            page += "[<a href=\"/view/" + mostrecentselfplayhash + "?viewer=eidogo\">EidoGo</a> / ";
            page += "<a href=\"/view/" + mostrecentselfplayhash + "?viewer=wgo\">WGo</a>] ";
            page += "<br>";
        }

        if (iprecentselfplayhash) {
            page += "View your most recent selfplay training game: ";
            page += "[<a href=\"/view/" + iprecentselfplayhash + "?viewer=eidogo\">EidoGo</a> / ";
            page += "<a href=\"/view/" + iprecentselfplayhash + "?viewer=wgo\">WGo</a>]";
            page += "<br>";
        }

        page += "<br><br>";
        page += "<a href=\"https://sjeng.org/zero/\">Raw SGF files</a>.<br>";
        page += "<a href=\"https://docs.google.com/spreadsheets/d/e/2PACX-1vTsHu7T9vbfLsYOIANnUX9rHAYu7lQ4AlpVIvCfn60G7BxNZ0JH4ulfbADEedPVgwHxaH5MczdH853l/pubchart?oid=286613333&format=interactive\">Original strength graph</a>. (Mostly obsolete.)<br>";
        page += "<br>";
        page += "<iframe width=\"950\" height=\"655\" seamless frameborder=\"0\" scrolling=\"no\" src=\"/static/elo.html\"></iframe>";
        page += "<br><br>Times are in GMT+0100 (CET)<br>\n";
        page += network_table;
        page += match_table;
        page += "</body></html>";
        res.send(page);
    });
}));

function shouldScheduleMatch (req, now) {
  if (!(pending_matches.length && req.params.version!=0 && fastClientsMap.get(req.ip))) {
    return false;
  }
  
  var match = pending_matches[pending_matches.length - 1];
  var deleted = match.requests.filter(e => e.timestamp < now - MATCH_EXPIRE_TIME).length;
  var oldest = (match.requests.length > 0 ? (now - match.requests[0].timestamp) / 1000 / 60 : 0).toFixed(2);
  match.requests.splice(0, deleted);
  var requested = match.requests.length;
  var needed = how_many_games_to_queue(
                match.number_to_play,
                match.network1_wins,
                match.network1_losses,
                PESSIMISTIC_RATE);
  var result = needed > requested;
  console.log(`Need ${needed} match games. Requested ${requested}, deleted ${deleted}. Oldest ${oldest}m ago. Will schedule ${result ? "match" : "selfplay"}.`);
  
  return result;
}

app.get('/get-task/:version(\\d+)', asyncMiddleware( async (req, res, next) => {
    var required_client_version = String(14);
    var required_leelaz_version = String("0.12");

    var random_seed = converter.hexToDec( "0x"+crypto.randomBytes(8).toString('hex') ).toString();

    // Pulling this now because if I wait inside the network2==null test, possible race condition if another get-task pops end of array?
    //
    var best_network_hash = await get_best_network_hash();
    var now = Date.now();

    // Track match assignments as they go out, so we don't send out too many. If more needed request them, otherwise selfplay.
    //
    if (shouldScheduleMatch(req, now)) {
        var match = pending_matches[pending_matches.length - 1];
        var task = {"cmd": "match", "required_client_version": required_client_version, "random_seed": random_seed, "leelaz_version" : required_leelaz_version};

        if (match.options.visits) match.options.playouts = "0";

        task.options = match.options;
        task.options_hash = match.options_hash;

        if (match.network2 == null) {
            match.network2 = best_network_hash;

            db.collection("matches").updateOne(
                { network1: match.network1, network2: null, options_hash: match.options_hash },
                { $set: { network2: best_network_hash } },
                { },
                (err, dbres) => {
                    if (err) {
                        console.log("ERROR: /get-task setting network2: " + err);
                        res.send("ERROR: /get-task setting network2: " + err);
                        return;
                    }
                    console.log("Match " + match._id + " set network2 to best: " + match.network2);
            });
        }

        match.game_color = !match.game_color
        
        if (match.game_color) {
            task.white_hash = match.network1;
            task.black_hash = match.network2;
        } else {
            task.white_hash = match.network2;
            task.black_hash = match.network1;
        }

        res.send(JSON.stringify(task));

        match.requests.push({timestamp: now, seed: random_seed});

        if (match.game_count >= match.number_to_play) pending_matches.pop();

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: match " + match.network1.slice(0,8) + " vs " + match.network2.slice(0,8) + " " + (match.game_count + match.requests.length) + " of " + match.number_to_play);
//    } else if ( req.params.version==1 && Math.random() > .2 ) {
//        var task = { "cmd": "wait", "minutes": "5" };
//
//        res.send(JSON.stringify(task));
//
//        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: wait");
    } else {
        // {"cmd": "selfplay", "hash": "xxx", "playouts": 1000, "resignation_percent": 3.0}
        var task  = {"cmd": "selfplay", "hash": "", "required_client_version": required_client_version, "random_seed": random_seed, "leelaz_version" : required_leelaz_version};

        // TODO In time we'll change this to a visits default instead of options default, for new --visits command
        //
        //var options = {"playouts": "1600", "resignation_percent": "10", "noise": "true", "randomcnt": "30"};
        var options = {"playouts": "0", "visits": "3200", "resignation_percent": "10", "noise": "true", "randomcnt": "30"};

        if (Math.random() < .2) options.resignation_percent = "0";

        //task.options_hash = checksum("" + options.playouts + options.resignation_percent + options.noise + options.randomcnt).slice(0,6);
        task.options_hash = get_options_hash(options);
        task.options = options;

        task.hash = best_network_hash;

        res.send(JSON.stringify(task));

        console.log(req.ip + " (" + req.headers['x-real-ip'] + ") " + " got task: selfplay");
    }
}));

// TODO: Replace this with a pug file
//
function eidogo_html(title, sgf) {
    var page = "<html><head>\n";
    page += "<title>" + title + "</title>\n";
    page += "<script type=\"text/javascript\">\n";
    page += "eidogoConfig = { theme: \"standard\", mode: \"view\", enableShortcuts: true };\n";
    page += "</script>\n";
    page += "<script type=\"text/javascript\" src=\"player/js/eidogo.min.js\"></script>\n";
    page += "</head><body>\n";
    page += "<div class=\"eidogo-player-auto\">\n";
    page += sgf;
    page += "</div></body></html>\n";

    return page;
}

app.get('/view/:hash(\\w+)', (req, res) => {
    Promise.all([
        db.collection("games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
        .then((game) => { 
            return (game.sgf);
        }),
    ]).then((responses) => {
        sgf = responses[0].replace(/(\n|\r)+/g, '');

        switch (req.query.viewer) {
            case "eidogo":
                res.send( eidogo_html("View training game" + req.params.hash, sgf) );
                break;
            case "wgo":
                res.render('wgo', { title: "View training game " + req.params.hash, sgf: sgf });
                break;
            default:
                //res.send( eidogo_html("View training game" + req.params.hash, sgf) );
                res.render('wgo', { title: "View training game " + req.params.hash, sgf: sgf });
        }
    }).catch( err => {
        res.send("No selfplay game was found with hash " + req.params.hash);
    });
});

app.get('/match-games/:matchid(\\w+)', (req, res) => {
    if (!req.params.matchid) {
        res.send("matchid missing");
        return;
    }

    var ipMap = new Map();

    var html = "<html><head>";
    html += "</head><body>\n";
    html += "<table border=1><tr><th>Client</th><th>Match Hash</th><th>Winner</th><th>Score</th><th>Move Count</th></tr>\n";

    db.collection("matches").findOne({ "_id": new ObjectId(req.params.matchid) })
    .then((match) => {
        db.collection("match_games").aggregate([
            { "$match": { "$or": [ 
               { winnerhash: match.network1, loserhash: match.network2, options_hash: match.options_hash },
               { winnerhash: match.network2, loserhash: match.network1, options_hash: match.options_hash }
            ] } },
            { "$sort": { _id: 1 } }
        ]).toArray()
        .then((list) => { 
            for (let item of list) {
                if (ipMap.get(item.ip) == null) {
                    ipMap.set(item.ip, ipMap.size + 1);
                }
                html += "<tr>";
                html += "<td>" + ipMap.get(item.ip) + "</td>";
                html += "<td><a href=\"/viewmatch/" + item.sgfhash + "?viewer=wgo\">" + item.sgfhash + "</a></td>";
                html += "<td>" + item.winnerhash.slice(0,8) + "</td>";
                html += "<td>" + item.score + "</td><td>" + item.movescount + "</td></tr>\n";
            }

            html += "</table></body></html>\n";

            res.send(html);
        }).catch( err => {
            res.send("No matches found for match " + req.params.matchid);
        });
    }).catch( err => {
        res.send("No match found for id " + req.params.hash);
    });

});

app.get('/viewmatch/:hash(\\w+)', (req, res) => {
    Promise.all([
        db.collection("match_games").findOne({ sgfhash: req.params.hash }, { _id: 0, sgf: 1 })
        .then((game) => { 
            return (game.sgf);
        }),
    ]).then((responses) => {
        sgf = responses[0].replace(/(\n|\r)+/g, '');

        switch (req.query.viewer) {
            case "eidogo":
                res.send( eidogo_html("View match " + req.params.hash, sgf) );
                break;
            case "wgo":
                res.render('wgo', { title: "View match " + req.params.hash, sgf: sgf });
                break;
            default:
                res.send( eidogo_html("View match " + req.params.hash, sgf) );
        }
    }).catch( err => {
        res.send("No match was found with hash " + req.params.hash);
    });
});

// TODO Make this whole thing a function, and cache it. Clear the cache when I clear cachematches (elograph won't
// change unless a new match result is uploaded.
//
app.get('/data/elograph.json',  asyncMiddleware( async (req, res, next) => {
    var cursor = db.collection("networks").aggregate( [ { $group: { _id: 1, count: { $sum: "$game_count" } } } ]);
    var totalgames = await cursor.next();

    var ratingsMap = new Map();
    var networks = [];

    Promise.all([
        db.collection("networks").find().sort({_id: -1}).toArray()
        .then((list) => { 
            for (let item of list) {
                totalgames.count -= item.game_count || 0;

                var mycount = (
                    (item.training_count === 0 || item.training_count) ? item.training_count : totalgames.count
                )

                if (item.game_count) {
                    networks.push({ "hash": item.hash, "game_count": item.game_count,
                        "net": mycount, "best": "true" });
                } else {
                    networks.push({ "hash": item.hash, "game_count": item.game_count,
                        "net": mycount, "best": "false" });
                }
            }

            return;
        }),
        db.collection("matches").aggregate([
            { "$lookup": { "localField": "network2", "from": "networks", "foreignField": "hash", "as": "merged" } }, { "$unwind": "$merged" }, { "$sort": { "merged._id": 1 } }
        ]).toArray()
        .then((list) => {
            for (let match of list) {
                var network2_rating = ratingsMap.get(match.network2) ? ratingsMap.get(match.network2).rating : 0;
                var sprt;
                var elo;

                // TODO If no ELO info, make rating -1 for graph to just hide it instead of assuming same elo as network 2.
                //
                if (match.network1_wins > 0 && match.network1_losses > 0) {
                    elo = CalculateEloFromPercent( match.network1_wins / match.game_count );
                } else {
                    var fakecount = match.game_count;
                    var fakewins = match.network1_wins;

                    if (fakewins == 0) {
                        fakewins++;
                        fakecount++;
                    }
 
                    if (match.network1_losses == 0) {
                        fakecount++;
                    }
 
                    elo = CalculateEloFromPercent( fakewins / fakecount );
                }

                switch (SPRT(match.network1_wins, match.network1_losses)) {
                    case false:
                        sprt = "FAIL";
                        break;

                    case true:
                        sprt = "PASS";
                        break;

                    default:
                        sprt = "???"
                }

                var info =  {
                    "rating": elo + network2_rating,
                    "sprt": sprt
                };

                ratingsMap.set(match.network1, info);
            }

            return;
        })
    ]).then((responses) => {
        var elograph_data;

        var json = networks.map( (item) => {
            var rating;

            if (ratingsMap.get(item.hash) === undefined) {
                rating = item.best === "true" ? 0 : -1;
            } else {
                rating = Math.round(ratingsMap.get(item.hash).rating);
            }
            var sprt = ratingsMap.get(item.hash) ? ratingsMap.get(item.hash).sprt : "???";
            var result_item = { "rating": rating, "net": Number(item.net + rating/100000), "sprt": sprt, "hash": item.hash.slice(0,6), "best": item.best };
            return JSON.stringify(result_item);
        }).join(",");

        res.send("[ " + json + " ]");
    }).catch( err => {
        console.log("ERROR data/elograph.json: " + err);
        res.send("ERROR data/elograph.json: " + err);
    });
}));

