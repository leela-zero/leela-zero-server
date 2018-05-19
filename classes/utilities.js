const path = require("path");
const fs = require('fs-extra');
const converter = require('hex2dec');
const {Long, ObjectId} = require('mongodb');
const crypto = require('crypto');
const safeObjectId = s => ObjectId.isValid(s) ? new ObjectId(s) : null;

// Default secret for task verification codes
var gTaskSecret = "";

/**
 * Sets the secret to be used for verification codes
 */
function set_task_verification_secret (secret) {
    gTaskSecret = secret;
}

/**
 * Compute a verification code from a secret and seed
 *
 * @param seed {string} Some value to compute a verification
 * @returns {string} The verification code
 */
function compute_task_verification (seed) {
    return checksum(gTaskSecret + seed, 'sha256');
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
function add_match_verification (task) {
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
function check_match_verification (data) {
    // Allow for 2 expected verification codes for swapped networks
    const expected = compute_task_verification(data.random_seed + data.winnerhash + data.loserhash);
    const expected2 = compute_task_verification(data.random_seed + data.loserhash + data.winnerhash);
    const provided = data.options_hash.slice(-expected.length);

    // Clean up the overloaded options_hash by removing the verification
    data.options_hash = data.options_hash.slice(0, -expected.length);
    data.verification = provided;

    return provided === expected || provided === expected2;
}

function network_exists(hash) {
    var network_file = path.join(__dirname, "..", "network", `${hash}.gz`);
    return fs.pathExistsSync(network_file);
}

function CalculateEloFromPercent(percentage) {
    return -400 * Math.log(1 / percentage - 1) / Math.LN10;
}

function checksum(str, algorithm, encoding) {
    return crypto
        .createHash(algorithm || 'md5')
        .update(str, 'utf8')
        .digest(encoding || 'hex')
}

/**
 * Generate a 64-bit Long seed that embeds a timestamp
 *
 * @param seconds {number} Timestamp seconds defaulting to now
 * @param highBits {number} Extra values for seed defaulting to 31-bit random
 * @returns {Long} A random number
 */
function make_seed(seconds = Date.now() / 1000,
                   highBits = converter.hexToDec(`0x${crypto.randomBytes(4).toString('hex')}`).toString() >>> 1) {
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

function objectIdFromDate(date) {
    //return Math.floor(date.getTime() / 1000).toString(16) + "0000000000000000";
    return safeObjectId(Math.floor(date / 1000).toString(16) + "0000000000000000");
}

// This comes from https://medium.com/@Abazhenov/using-async-await-in-express-with-node-8-b8af872c0016
//
const asyncMiddleware = fn =>
    function (req, res, next, ...args) {
        const fnReturn = fn(req, res, next, ...args)
        return Promise.resolve(fnReturn).catch(next)
    }

function log_memory_stats(string) {
    console.log(string);
    const used = process.memoryUsage();

    for (let key in used) {
        var size = (used[key] / 1024 / 1024).toFixed(2);

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

    var N = W + L;
    var w = W / N;
    var s = w;
    var m2 = w;
    var variance = m2 - s ** 2;
    var variance_s = variance / N;
    var s0 = LL(elo0);
    var s1 = LL(elo1);

    return (s1 - s0) * (2 * s - s0 - s1) / variance_s / 2.0;
}

//function SPRTold(W,L,elo0,elo1)
function SPRTold(W, L) {
    var elo0 = 0, elo1 = 35;
    var alpha = .05, beta = .05;

    var LLR_ = LLR(W, L, elo0, elo1);
    var LA = Math.log(beta / (1 - alpha));
    var LB = Math.log((1 - beta) / alpha);

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
    var aimPerc = aim / max;
    var remaining = max - w - l;
    var expected = remaining * aimPerc;
    var maxExpected = expected + 3 * stDev(remaining)
    var needed = aim - w;
    return maxExpected > needed;
}

function SPRT(w, l) {
    var max = 400;
    var aim = max / 2 + 2 * stDev(max);
    if (w + l >= max && w / (w + l) >= (aim / max)) return true;
    if (!canReachLimit(w, l, max, aim)) return false;
    return SPRTold(w, l);
}

var QUEUE_BUFFER = 25;

function how_many_games_to_queue(max_games, w_obs, l_obs, pessimistic_rate, isBest) {
    var games_left = max_games - w_obs - l_obs;

    if (isBest || SPRT(w_obs, l_obs) === true) {
        return games_left;
    }

    if (SPRT(w_obs, l_obs) === false) {
        return 0;
    }

    for (var queued_games = 0; queued_games < games_left; queued_games++) {
        if (SPRT(w_obs + queued_games * pessimistic_rate, l_obs + queued_games * (1 - pessimistic_rate)) === false) {
            return queued_games + QUEUE_BUFFER;
        }
    }

    return games_left + QUEUE_BUFFER;
}

module.exports = {
    set_task_verification_secret,
    compute_task_verification,
    add_match_verification,
    check_match_verification,
    network_exists,
    checksum,
    make_seed,
    get_timestamp_from_seed,
    seed_from_mongolong,
    CalculateEloFromPercent,
    objectIdFromDate,
    log_memory_stats,
    SPRT,
    LLR,
    asyncMiddleware,
    how_many_games_to_queue,
}
