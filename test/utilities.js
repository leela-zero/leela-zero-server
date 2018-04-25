const { network_exists, asyncMiddleware, SPRT } = require('../classes/utilities.js');
var assert = require('assert');
const crypto = require('crypto');

describe('Utilities', function () {
    describe('#network_exists(hash)', function () {
        var hash = crypto.randomBytes(256 / 8).toString('hex');

        var tests = [
            { description: 'should return false for random hash (' + hash + ')', input: hash, expect: false },
            { description: 'should return false for null input', input: null, expect: false },
        ];

        tests.forEach(test => it(test.description, () => assert.equal(network_exists(test.input), test.expect)));
    });

    describe('#asyncMiddleware()', function () {
        it('should catch error and pass it to the next() handler', async () => {
            var intendedError = new Error('intended error');

            asyncMiddleware(async () => {
                throw intendedError;
            })(null, null, err => assert.equal(intendedError, err));

        });

    });

    describe('#SPRT(w, l)', function () {
        it('should not be true for games <= 100', function () {
            for (var l = 0; l <= 100; l++) {
                for (var w = 0; w + l <= 100; w++) {
                    assert.notEqual(SPRT(w, l), true);
                }
            }
        });

        it('should not be false for win = 220 and games <= 400', function () {
            var w = 220;
            for (var l = 0; l <= 400 - w; l++) {
                assert.notEqual(SPRT(w, l), false);
            }
        })

        it('should not be true for lose = 181 and games <= 400', function () {
            var l = 181;
            for (var w = 0; w <= 400 - l; w++) {
                assert.notEqual(SPRT(w, l), true);
            }
        })
    });
});