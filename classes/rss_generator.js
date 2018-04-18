const rss = require('rss');
const moment = require('moment');

class rss_generator {

    generate(networks, http_host) {

        var feed = new rss({
            title: 'Leela Zero Best Networks',
            feed_url: `${http_host}/rss`,
            site_url: http_host,
        });

        for (let n in networks) {
            var network = networks[n];
            var date = new moment(network._id.getTimestamp());

            feed.item({
                title: `LZ#${n} ${network.hash.slice(0, 6)}`,
                description: `${network.filters} x ${network.blocks} `,
                url: `${http_host}/network-profiles/${network.hash}`,
                date: date.utc()
            });
        }

        return feed.xml();
    }
}

module.exports = rss_generator;