const SI_PREFIXES = ["", "k", "M", "G", "T", "P", "E"];

// From https://stackoverflow.com/questions/9461621/how-to-format-a-number-as-2-5k-if-a-thousand-or-more-otherwise-900-in-javascrip
//
function abbreviateNumber(number, length) {
    // what tier? (determines SI prefix)
    var tier = Math.log10(number) / 3 | 0;

    // if zero, we don't need a prefix
    if (tier == 0) return number;

    // get prefix and determine scale
    var prefix = SI_PREFIXES[tier];
    var scale = Math.pow(10, tier * 3);

    // scale the number
    var scaled = number / scale;

    // format number and add prefix as suffix
    return scaled.toPrecision(length) + prefix;
}

Number.prototype.abbr = function (length) {
    return abbreviateNumber(this, length);
};
