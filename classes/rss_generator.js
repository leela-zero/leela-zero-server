const rss = require('rss');
const moment = require('moment');

class rss_generator {

    generate(networks) {

        var feed = new rss({
            title: 'Leela Zero Best Networks',
            feed_url: 'http://zero.sjeng.org/rss',
            site_url: 'http://zero.sjeng.org',
        });

        for (let n in networks) {
            var network = networks[n];
            var date = new moment(network._id.getTimestamp());

            feed.item({
                title: `LZ#${n} ${network.hash.slice(0, 6)}`,
                description: `${network.filters} x ${network.blocks} `,
                url: `http://zero.sjeng.org/networks/${network.hash}`,
                date: date.utc()
            });
        }

        return feed.xml();
    }
}

module.exports = rss_generator;