const { Writable } = require('stream');

class weight_parser extends Writable {
    constructor(options) {
        super(options);
        this.newline = this.space = 0;
    }

    write(chunk, encoding, next) {
        // Reference:
        //   - filters, https://github.com/gcp/leela-zero/blob/97c2f8137a3ea24938116bfbb2b0ff05c83903f0/src/Network.cpp#L207-L212
        //   - blocks, https://github.com/gcp/leela-zero/blob/97c2f8137a3ea24938116bfbb2b0ff05c83903f0/src/Network.cpp#L217
        //
        for (let x = 0; x < chunk.length; ++x) {
            var c = chunk[x];

            if (c == 0x0A)   // 0X0A = '\n' = newline
                this.newline++;
            else if (this.newline == 2 && c == 0x20)  // 0x20 = ' ' = space
                this.space++;
        }
    }

    read() {
        var filters = this.space + 1, blocks = (this.newline + 1 - (1 + 4 + 14)) / 8;

        if(!Number.isInteger(blocks))
            blocks = 0;

        return { filters : filters, blocks : blocks };
    }
}

module.exports = weight_parser;