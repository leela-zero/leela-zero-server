const config = require("../config");
const request = require("request");

function network_promotion_notify(hash) {
    if (!config.discord_webhook) {
        return;
    }
    const message = "New network promoted: " + hash;
    request.post(
        config.discord_webhook,
        { json: { content: message } },
    );
}

module.exports = {
    network_promotion_notify
};
