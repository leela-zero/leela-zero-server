const rss = require("rss");
const moment = require("moment");

class rss_generator {
    generate(networks, http_host) {
        const feed = new rss({
            title: "Leela Zero Best Networks",
            feed_url: `${http_host}/rss`,
            site_url: http_host
        });

        for (const n in networks) {
            const network = networks[n];
            const date = new moment(network._id.getTimestamp());

            feed.item({
                title: `LZ#${n} ${network.hash.slice(0, 6)}`,
                description: `${network.blocks} x ${network.filters} `,
                url: `${http_host}/network-profiles/${network.hash}`,
                date: date.utc()
            });
        }

        return feed.xml();
    }
}

module.exports = rss_generator;
