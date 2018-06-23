const Cacheman = require("cacheman");
const {
    objectIdFromDate,
    SPRT,
    LLR
} = require("./utilities.js");

const cache_matches = new Cacheman("matches", { ttl: "1y" });

function _update_winrate(matches) {
    matches.forEach(match => {
        match.SPRT = SPRT(match.network1_wins, match.network1_losses);
        if (match.SPRT === null) {
            match.SPRT = Math.round(100 * (2.9444389791664403 + LLR(match.network1_wins, match.network1_losses, 0, 35)) / 5.88887795833);
        }
        match.winrate = (match.network1_wins && match.network1_wins * 100 / (match.network1_wins + match.network1_losses)).toFixed(2);
    });
}

async function get_matches_from_db(db, { limit = 100, network } = {}) {
    const matches = await db.collection("matches")
        .aggregate([
            ...(network ? [{ $match: { $or: [{ network1: network }, { network2: network }] } }] : []),
            { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "network2" } }, { $unwind: "$network2" },
            { $lookup: { localField: "network1", from: "networks", foreignField: "hash", as: "network1" } }, { $unwind: "$network1" },
            { $sort: { _id: -1 } },
            {
                $project: {
                    "network1._id": 0,
                    "network1.ip": 0,
                    "network2._id": 0,
                    "network2.ip": 0
                }
            },
            { $limit: limit }
        ]).toArray();

    matches.forEach(match => {
        match.time = match._id.getTimestamp().getTime();
    });
    _update_winrate(matches);

    return matches;
}

async function get_matches_from_cache(db, limit = 100) {
    const matches = await cache_matches.wrap("matches", () => get_matches_from_db(db));
    return matches.slice(0, limit);
}

// Win/Lose count of a match changed
async function update_matches_stats_cache(db, match_id, is_network1_win) {
    const matches = await get_matches_from_cache(db);
    const match = matches.find(item => item._id.toString() == match_id);
    match.game_count += 1;
    if (is_network1_win) {
        match.network1_wins += 1;
    } else {
        match.network1_losses += 1;
    }
    _update_winrate([match]);
    cache_matches.set("matches", matches);
}

function clear_matches_cache() {
    cache_matches.clear(() => console.log("Cleared new match cache."));
}

// Get access log begin with `url`
async function get_access_logs(db, url) {
    const logs = await db.collection("logs")
        .find({
            url,
            _id: {
                $gt: objectIdFromDate(Date.now() - 24 * 60 * 60 * 7 * 1000)
            }
        })
        .sort({ _id: 1 }).toArray();
    logs.forEach(log => {
        if (!log.time) {
            log.time = log._id.getTimestamp().getTime();
        }
    });
    return logs;
}

module.exports = {
    get_matches_from_db,
    get_matches_from_cache,
    update_matches_stats_cache,
    clear_matches_cache,
    get_access_logs
};
