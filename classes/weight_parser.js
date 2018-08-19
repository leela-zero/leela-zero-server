const { Writable } = require("stream");

class weight_parser extends Writable {
    constructor(options) {
        super(options);
        this.newline = this.space = 0;
        this.lastNewline = null;
        this.filters = null;
        this.blocks = null;
    }

    write(chunk) {
        const v = chunk[0];

        if (v == 0x31 || v == 0x32) {
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
        } else { // Assuming v3 or greater
            // Reference: https://github.com/gcp/leela-zero/blob/2d6e5bbf3d13ef1c949a937a29583cf6b423f7d4/src/Network.cpp#L271-L286
            this.blocks = chunk[7] | (chunk[8] << 8);
            this.filters = chunk[9] | (chunk[10] << 8);
        }
    }

    read() {
        // v3 networks just give this data in the header
        if (this.filters != null && this.blocks != null) {
            const filters = this.filters;
            const blocks = this.blocks;
            return { filters, blocks };
        }

        // v1 and v2 networks need to calculate it
        const filters = this.space + 1;
        let blocks = (this.newline + (this.lastNewline ? 0 : 1) - (1 + 4 + 14)) / 8;

        if (!Number.isInteger(blocks))
            blocks = 0;

        return { filters, blocks };
    }
}

module.exports = weight_parser;
