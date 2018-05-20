const { Writable } = require("stream");

class weight_parser extends Writable {
    constructor(options) {
        super(options);
        this.newline = this.space = 0;
        this.lastNewline = null;
    }

    write(chunk) {
        // Reference:
        //   - filters, https://github.com/gcp/leela-zero/blob/97c2f8137a3ea24938116bfbb2b0ff05c83903f0/src/Network.cpp#L207-L212
        //   - blocks, https://github.com/gcp/leela-zero/blob/97c2f8137a3ea24938116bfbb2b0ff05c83903f0/src/Network.cpp#L217
        //
        for (let x = 0; x < chunk.length; ++x) {
            const c = chunk[x];

            if (c == 0x0A) // 0X0A = '\n' = newline
                this.newline++;
            else if (this.newline == 2 && c == 0x20) // 0x20 = ' ' = space
                this.space++;
        }
        // track whether the weight file ended with newline
        this.lastNewline = chunk[chunk.length - 1] == 0x0A;
    }

    read() {
        const filters = this.space + 1;
        let blocks = (this.newline + (this.lastNewline ? 0 : 1) - (1 + 4 + 14)) / 8;

        if (!Number.isInteger(blocks))
            blocks = 0;

        return { filters, blocks };
    }
}

module.exports = weight_parser;
