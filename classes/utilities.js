const path = require("path");
const fs = require("fs-extra");
const converter = require("hex2dec");
const { Long, ObjectId } = require("mongodb");
const crypto = require("crypto");
const safeObjectId = s => ObjectId.isValid(s) ? new ObjectId(s) : null;

// Default secret for task verification codes
let gTaskSecret = "";

/**
 * Sets the secret to be used for verification codes
 */
function set_task_verification_secret(secret) {
    gTaskSecret = secret;
}

/**
 * Compute a verification code from a secret and seed
 *
 * @param seed {string} Some value to compute a verification
 * @returns {string} The verification code
 */
function compute_task_verification(seed) {
    return checksum(gTaskSecret + seed, "sha256");
}

/**
 * Modify a match task to include secret-derived verification
 *
 * @param task {object} The task to modify with some required properties:
 *          black_hash {string} Network for white included in verification
 *          random_seed {string} Seed for the task reused for verification
 *          white_hash {string} Network for black included in verification
 *          options_hash {string} Existing hash to append verification
 */
function add_match_verification(task) {
    // Append the verification to options_hash as the client responds with it
    task.options_hash += compute_task_verification(task.random_seed + task.white_hash + task.black_hash);
}

/**
 * Check and clean up the verification from submitted match data
 *
 * @param data {object} The submission form data with required properties:
 *          loserhash {string} Network for loser to recompute the verification
 *          random_seed {string} Seed to recompute the verification
 *          winnerhash {string} Network for winner to recompute the verification
 *          options_hash {string} Hash to extract verification
 *          verification {string} Will be updated with the verification
 * @returns {bool} True if the verification code is consistent with the data
 */
function check_match_verification(data) {
    // Allow for 2 expected verification codes for swapped networks
    const expected = compute_task_verification(data.random_seed + data.winnerhash + data.loserhash);
    const expected2 = compute_task_verification(data.random_seed + data.loserhash + data.winnerhash);
    const provided = data.options_hash.slice(-expected.length);

    // Clean up the overloaded options_hash by removing the verification
    data.options_hash = data.options_hash.slice(0, -expected.length);
    data.verification = provided;

    return provided === expected || provided === expected2;
}

/**
 * Add Gzip hash to Task
 *
 * @param task {object} Could be self-play or match task
 * @returns {void}
 *      add `hash_gzip_hash` to self-play task
 *      add `white_hash_gzip_hash` & `black_hash_gzip_hash` to match task
 */
async function add_gzip_hash(task) {
    if (task.hash) {
        // self-play task
        task.hash_gzip_hash = await compute_gzip_hash(task.hash);
    } else if (task.white_hash && task.black_hash) {
        // match task
        task.white_hash_gzip_hash = await compute_gzip_hash(task.white_hash);
        task.black_hash_gzip_hash = await compute_gzip_hash(task.black_hash);
    } else {
        // do nothing
    }
}

/**
 * Compute Gzip hash from Network hash
 *
 * @param hash {string} Network hash
 * @returns {string} Gzip hash, return null if Network hash is not found or
 *                   error occured during computation.
 */
function compute_gzip_hash(hash) {
    if (network_exists(hash)) {
        // Local cache initialization
        if (!this.cache) {
            this.cache = {};
        }

        // Cache hit, return immediately
        if (this.cache[hash]) {
            return this.cache[hash];
        }

        // Cache miss, let's compute gzip hash
        const network_file = path.join(__dirname, "..", "network", `${hash}.gz`);
        const sha256 = crypto.createHash("sha256");

        return new Promise(resolve => fs.createReadStream(network_file)
                .pipe(sha256)
                .on("finish", () => {
                    const gzip_hash = sha256.read().toString("hex");
                    this.cache[hash] = gzip_hash;
                    resolve(gzip_hash);
                })
                .on("error", () => resolve(null))
        );
    }
    return null;
}

function network_exists(hash) {
    const network_file = path.join(__dirname, "..", "network", `${hash}.gz`);
    return fs.pathExistsSync(network_file);
}

function CalculateEloFromPercent(percentage) {
    return -400 * Math.log(1 / percentage - 1) / Math.LN10;
}

function checksum(str, algorithm, encoding) {
    return crypto
        .createHash(algorithm || "md5")
        .update(str, "utf8")
        .digest(encoding || "hex");
}

/**
 * Generate a 64-bit Long seed that embeds a timestamp
 *
 * @param seconds {number} Timestamp seconds defaulting to now
 * @param highBits {number} Extra values for seed defaulting to 31-bit random
 * @returns {Long} A random number
 */
function make_seed(seconds = Date.now() / 1000,
                   highBits = converter.hexToDec(`0x${crypto.randomBytes(4).toString("hex")}`).toString() >>> 1) {
    return new Long(seconds, highBits);
}

/**
 * Extract the timestamp embedded in a seed
 *
 * @param seed {Long} The value to extract from
 * @returns {number} Timestamp (seconds)
 */
function get_timestamp_from_seed(seed) {
    return seed.getLowBitsUnsigned();
}

function seed_from_mongolong(seed) {
    return converter.hexToDec(
        "0x"
        + (new Uint32Array([seed.getHighBits()]))[0].toString(16)
        + (new Uint32Array([seed.getLowBits()]))[0].toString(16).padStart(8, "0")
    ).toString();
}

//console.log("Small int test 777: " + seed_from_mongolong(Long.fromString("777", 10)));
//console.log("Broken int test 883863265504794200: " + seed_from_mongolong(Long.fromString("883863265504794200", 10)));

/**
 * Process a list of games and modify items to hide IP, calculate duration, etc.
 */
function process_games_list(list, ip, winner = "") {
    const ipMap = new Map();
    let wins = 0;
    list.forEach((item, index) => {
        if (!ipMap.has(item.ip)) {
            ipMap.set(item.ip, item.ip == ip ? "you" : ipMap.size + 1);
        }
        // Replace IP here before going to pug view
        item.ip = ipMap.get(item.ip);

        // Update win rate stats from games so far
        wins += item.winnerhash == winner;
        item.num = index + 1;
        item.winrate = (wins / item.num * 100).toFixed(2);

        // Extract timestamp from seed to calculate game start time and duration
        const seed = (s => s instanceof Long ? s : new Long(s))(item.random_seed);
        const startTime = get_timestamp_from_seed(seed);

        // Display some times if they're reasonable
        const displayMinutes = (key, reference) => {
            const minutes = (reference / 1000 - startTime) / 60;
            item[key] = minutes >= 0 && minutes <= 24 * 60 ? minutes.toFixed(1) : "???";
        };
        displayMinutes("started", Date.now());
        displayMinutes("duration", item._id.getTimestamp());
    });
}

function objectIdFromDate(date) {
    //return Math.floor(date.getTime() / 1000).toString(16) + "0000000000000000";
    return safeObjectId(Math.floor(date / 1000).toString(16) + "0000000000000000");
}

// This comes from https://medium.com/@Abazhenov/using-async-await-in-express-with-node-8-b8af872c0016
//
const asyncMiddleware = fn => function(req, res, next, ...args) {
    const fnReturn = fn(req, res, next, ...args);
    return Promise.resolve(fnReturn).catch(next);
};

function log_memory_stats(string) {
    console.log(string);
    const used = process.memoryUsage();

    for (let key in used) {
        let size = (used[key] / 1024 / 1024).toFixed(2);

        size = " ".repeat(6 - size.length) + size;
        key += " ".repeat(9 - key.length);
        console.log(`\t${key} ${size} MB`);
    }
}

//SPRT
//
function LL(x) {
    return 1 / (1 + 10 ** (-x / 400));
}

function LLR(W, L, elo0, elo1) {
    //if (W==0 || L==0) return 0;
    if (!W) W = 1;
    if (!L) L = 1;

    const N = W + L;
    const w = W / N;
    const s = w;
    const m2 = w;
    const variance = m2 - s ** 2;
    const variance_s = variance / N;
    const s0 = LL(elo0);
    const s1 = LL(elo1);

    return (s1 - s0) * (2 * s - s0 - s1) / variance_s / 2.0;
}

//function SPRTold(W,L,elo0,elo1)
function SPRTold(W, L) {
    const elo0 = 0;
    const elo1 = 35;
    const alpha = 0.05;
    const beta = 0.05;

    const LLR_ = LLR(W, L, elo0, elo1);
    const LA = Math.log(beta / (1 - alpha));
    const LB = Math.log((1 - beta) / alpha);

    if (LLR_ > LB && W + L > 100) {
        return true;
    } else if (LLR_ < LA) {
        return false;
    } else {
        return null;
    }
}

function stDev(n) {
    return Math.sqrt(n / 4);
}

function canReachLimit(w, l, max, aim) {
    const aimPerc = aim / max;
    const remaining = max - w - l;
    const expected = remaining * aimPerc;
    const maxExpected = expected + 3 * stDev(remaining);
    const needed = aim - w;
    return maxExpected > needed;
}

function SPRT(w, l) {
    const max = 400;
    const aim = max / 2 + 2 * stDev(max);
    if (w + l >= max && w / (w + l) >= (aim / max)) return true;
    if (!canReachLimit(w, l, max, aim)) return false;
    return SPRTold(w, l);
}

const QUEUE_BUFFER = 25;

function how_many_games_to_queue(max_games, w_obs, l_obs, pessimistic_rate, isBest) {
    const games_left = max_games - w_obs - l_obs;

    if (isBest || SPRT(w_obs, l_obs) === true) {
        return games_left;
    }

    if (SPRT(w_obs, l_obs) === false) {
        return 0;
    }

    for (let queued_games = 0; queued_games < games_left; queued_games++) {
        if (SPRT(w_obs + queued_games * pessimistic_rate, l_obs + queued_games * (1 - pessimistic_rate)) === false) {
            return queued_games + QUEUE_BUFFER;
        }
    }

    return games_left + QUEUE_BUFFER;
}

module.exports = {
    CalculateEloFromPercent,
    LLR,
    SPRT,
    add_gzip_hash,
    add_match_verification,
    asyncMiddleware,
    check_match_verification,
    checksum,
    compute_task_verification,
    get_timestamp_from_seed,
    how_many_games_to_queue,
    log_memory_stats,
    make_seed,
    network_exists,
    objectIdFromDate,
    process_games_list,
    seed_from_mongolong,
    set_task_verification_secret
};
