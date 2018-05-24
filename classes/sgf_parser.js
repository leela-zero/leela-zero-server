const {
    Writable
} = require('stream');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

class sgf_parser extends Writable {
    constructor(options) {
        super(options);
        this.output_dir = options.output_dir;
        this.db = options.db;
    }

    sgf2quadrant(move) {
        if (move == "tt") return {
            quadrant: [],
            move: {
                sgf: move,
                coord: "pass"
            },
        };

        let x = move.charCodeAt(0) - 97,
            y = 116 - move.charCodeAt(1),
            quadrant = [];

        if (y >= 10 && x >= 10) quadrant.push(1);
        else if (y >= 10 && x <= 10) quadrant.push(2);
        else if (y <= 10 && x <= 10) quadrant.push(3);
        else if (y <= 10 && x >= 10) quadrant.push(4);

        return {
            quadrant: quadrant,
            move: { coord: String.fromCharCode(x + 65 + (x > 7)) + y }
        };
    }

    parse_winner(sgf_buffer, game) {
        var result_reg = /RE\[(B|W)/;
        game.winner = result_reg.test(sgf_buffer) && RegExp.$1;
    }

    parse_players(sgf_buffer, game) {
        var player_reg = /P(W|B)\[([^\]]+)\]/g;
        var m = null;
        while (m = player_reg.exec(sgf_buffer)) {
            var player = m[2].split(' ');
            game[m[1]] = {
                hash: player.pop().slice(0, 6),
                client: player.join(' ')
            };
        }
    }
    parse_move(sgf_buffer, game) {
        var move_reg = /;(W|B)\[(\w{2})\]/g, m, stop = [];
        game.quadrant1 = [];
        game.quadrant2 = [];
        game.quadrant3 = [];
        game.quadrant4 = [];

        while (stop.length < 4 && (m = move_reg.exec(sgf_buffer))) {
            var q = this.sgf2quadrant(m[2]);
            q.move.player = m[1];

            if (q.quadrant.length) {
                for (let n of q.quadrant) {
                    
                    if (stop.includes(n))
                        continue;
                    
                    var target = game['quadrant' + n];
                    var last = null;
                    if (target.length)
                        last = target[target.length - 1].player;

                    if (last != m[1])
                        target.push(q.move);
                    else
                        stop.push(n);
                }
            }
        }

    }

    _write(chunk, encoding, next) {
        (async () => {
            await this.write_internal(chunk);
            next();
        })();
    }

    async _final(next) {
        if (this.buffer) {
            await this.process_sgf(this.buffer);
            next();
        }
    }

    async process_sgf(sgf_buffer) {
        var hash = crypto.createHash('sha256')
            .update(sgf_buffer)
            .digest('hex');

        //fs.writeFileSync(path.join(this.output_dir, hash + ".sgf"), sgf_buffer);

        var game = {};

        this.parse_winner(sgf_buffer, game);
        this.parse_players(sgf_buffer, game);
        this.parse_move(sgf_buffer, game);

        if (!this.num)
            this.num = 0;

        if (!this.games)
            this.games = [];

        this.num++;
        if (this.num % 1000 == 0)
            console.log('game #' + this.num);
        game._id = hash;
        await this.db.collection('opening').updateOne({ _id: hash }, { $set: game }, { upsert: true });
    }

    async write_internal(chunk) {
        var start = null;
        for (var i = 0; i < chunk.length; i++) {

            // start '('
            if (chunk[i] == 0x28) {
                var sgf_buffer = null;

                if (start !== null) {
                    // a complete sgf within this chunk
                    sgf_buffer = Buffer.alloc(i - start)
                    chunk.copy(sgf_buffer, 0, start, i);
                } else if (this.buff) {
                    // a complete sgf from internal buffer + this chunk
                    sgf_buffer = Buffer.alloc(this.buffer.length + i);
                    this.buffer.copy(sgf_buffer, 0, 0, this.buffer.length);
                    chunk.copy(sgf_buffer, this.buffer.length, 0, i);
                    this.buffer = null;
                }

                // we got a complete sgf!
                if (sgf_buffer) {
                    await this.process_sgf(sgf_buffer);
                }

                // mark the starting of the new sgf
                start = i;
            }
        }

        // save incomplete sgf internally
        this.buffer = Buffer.alloc(chunk.length - start);
        chunk.copy(this.buffer, 0, start, chunk.length);
    }


}

module.exports = sgf_parser;