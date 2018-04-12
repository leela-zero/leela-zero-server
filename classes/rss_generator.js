const rss = require('rss');
const moment = require('moment');

class rss_generator {

    generate(networks) {
        
        var feed = new rss({
            title: 'Leela Zero Best Networks',
            feed_url: 'http://zero.sjeng.org/feed/rss',
            site_url: 'http://zero.sjeng.org',
        });

        for(let network of networks) {
            var date = new moment(network._id.getTimestamp());

            feed.item({
                title:  network.hash,
                description: `${network.filters} x ${network.blocks} `,
                url: `http://zero.sjeng.org/network/${network.hash}.gz`, 
                date: date.utc()
            });
        }

        return feed.xml();
    }
}

module.exports = rss_generator;