const {
    Writable
} = require("stream");
const crypto = require("crypto");

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
            }
        };

        const x = move.charCodeAt(0) - 97;
        const y = 116 - move.charCodeAt(1);
        const quadrant = [];

        if (y >= 10 && x >= 10) quadrant.push(1);
        else if (y >= 10 && x <= 10) quadrant.push(2);
        else if (y <= 10 && x <= 10) quadrant.push(3);
        else if (y <= 10 && x >= 10) quadrant.push(4);

        return {
            quadrant,
            move: { coord: String.fromCharCode(x + 65 + (x > 7)) + y }
        };
    }

    parse_winner(sgf_buffer, game) {
        const result_reg = /RE\[(B|W)/;
        game.winner = result_reg.test(sgf_buffer) && RegExp.$1;
    }

    parse_players(sgf_buffer, game) {
        const player_reg = /P(W|B)\[([^\]]+)\]/g;
        let m = null;
        while ((m = player_reg.exec(sgf_buffer))) {
            const player = m[2].split(" ");
            game[m[1]] = {
                hash: player.pop().slice(0, 6),
                client: player.join(" ")
            };
        }
    }

    parse_move(sgf_buffer, game) {
        const move_reg = /;(W|B)\[(\w{2})\]/g;
        let m;
        const stop = [];
        game.quadrant1 = [];
        game.quadrant2 = [];
        game.quadrant3 = [];
        game.quadrant4 = [];

        while (stop.length < 4 && (m = move_reg.exec(sgf_buffer))) {
            const q = this.sgf2quadrant(m[2]);
            q.move.player = m[1];

            if (q.quadrant.length) {
                for (const n of q.quadrant) {
                    if (stop.includes(n))
                        continue;

                    const target = game["quadrant" + n];
                    let last = null;
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
        this.write_internal(chunk).then(next);
    }

    _final(next) {
        if (this.buffer) {
            this.process_sgf(this.buffer).then(next);
        } else {
            next();
        }
    }

    async process_sgf(sgf_buffer) {
        const hash = crypto.createHash("sha256")
            .update(sgf_buffer)
            .digest("hex");

        //fs.writeFileSync(path.join(this.output_dir, hash + ".sgf"), sgf_buffer);

        const game = {};

        this.parse_winner(sgf_buffer, game);
        this.parse_players(sgf_buffer, game);
        this.parse_move(sgf_buffer, game);

        if (!this.num)
            this.num = 0;

        this.num++;
        if (this.num % 10000 == 0)
            console.log("[" + new Date().toLocaleTimeString() + "][extract]: game #" + this.num);
        game._id = hash;
        await this.db.collection("opening").updateOne({ _id: hash }, { $set: game }, { upsert: true });
    }

    async write_internal(chunk) {
        let start = null;
        for (let i = 0; i < chunk.length; i++) {
            // start "("
            if (chunk[i] == 0x28) {
                let sgf_buffer = null;

                if (start !== null) {
                    // a complete sgf within this chunk
                    sgf_buffer = Buffer.from(chunk.buffer, start, i - start + 1);
                } else if (this.buff) {
                    // a complete sgf from internal buffer + this chunk
                    sgf_buffer = Buffer.concat(this.buffer.buffer, Buffer.from(chunk, 0, i + 1));
                }

                // we got a complete sgf!
                if (sgf_buffer) {
                    await this.process_sgf(sgf_buffer);
                }

                // mark the starting of the new sgf
                start = i;
            }
        }

        if (this.buffer) {
            const tmp = Buffer.alloc(this.buffer.length + chunk.length - start);
            this.buffer.copy(tmp, 0, 0, this.buffer.length);
            chunk.copy(tmp, this.buffer.length, start, chunk.length);
            this.buffer = tmp;
        } else {
            // save incomplete sgf internally
            this.buffer = Buffer.alloc(chunk.length - start);
            chunk.copy(this.buffer, 0, start, chunk.length);
        }
    }
}

module.exports = sgf_parser;
