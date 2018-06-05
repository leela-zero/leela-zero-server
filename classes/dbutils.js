const {
    SPRT,
    LLR
} = require("./utilities.js");

async function get_matches(db, limit) {
    const matches = await db.collection("matches")
        .aggregate([
            { $lookup: { localField: "network2", from: "networks", foreignField: "hash", as: "network2" } }, { $unwind: "$network2" },
            { $lookup: { localField: "network1", from: "networks", foreignField: "hash", as: "network1" } }, { $unwind: "$network1" },
            { $sort: { _id: -1 } },
            { $limit: limit }
        ]).toArray();

    matches.forEach(match => {
        match.time = match._id.getTimestamp().getTime();
        match.SPRT = SPRT(match.network1_wins, match.network1_losses);
        if (match.SPRT === null) {
            match.SPRT = Math.round(100 * (2.9444389791664403 + LLR(match.network1_wins, match.network1_losses, 0, 35)) / 5.88887795833);
        }
    });

    return matches;
}

module.exports = {
    get_matches
};