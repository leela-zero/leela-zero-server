const {
    set_task_verification_secret,
    compute_task_verification,
    add_match_verification,
    check_match_verification,
    network_exists,
    asyncMiddleware,
    SPRT
} = require('../classes/utilities.js');
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

describe('Task Verification', () => {
    const EMPTY_CODE = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const ABCD_CODE = '88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589';
    const CDAB_CODE = 'b7caca69b8597456e5db1676b6e6f930527f14c452bf4454a1398c40dc04ee78';

    afterEach(() => set_task_verification_secret(''));

    describe('#set_task_verification_secret(secret)', () => {
        it('should use a default secret', () => {
            const code = compute_task_verification('');

            assert.equal(code, EMPTY_CODE);
        });

        it('should have a default empty string secret', () => {
            set_task_verification_secret('');
            const code = compute_task_verification('');

            assert.equal(code, EMPTY_CODE);
        });

        it('should change secrets', () => {
            set_task_verification_secret('abcd');
            const code = compute_task_verification('');

            assert.equal(code, ABCD_CODE);
        });

        it('should use the latest secret', () => {
            set_task_verification_secret('abcd');
            set_task_verification_secret('cdab');
            const code = compute_task_verification('');

            assert.equal(code, CDAB_CODE);
        });
    });

    describe('#compute_task_verification(seed)', () => {
        it('should compute a code with empty', () => {
            const code = compute_task_verification('');

            assert.equal(code, EMPTY_CODE);
        });

        it('should compute a code with strings', () => {
            const code = compute_task_verification('abcd');

            assert.equal(code, ABCD_CODE);
        });

        it('should compute a code with numbers', () => {
            const code = compute_task_verification(1234);

            assert.equal(code, '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4');
        });
    });

    describe('#add_match_verification(task)', () => {
        it('should append code to options_hash', () => {
            const options_hash = 'abcd';
            const task = {
                black_hash: '',
                options_hash,
                random_seed: '',
                white_hash: ''
            };

            add_match_verification(task);

            assert.equal(task.options_hash, options_hash + EMPTY_CODE);
        });
    });

    describe('#check_match_verification(data)', () => {
        var data;
        beforeEach(() => {
            data = {
                loserhash: '',
                options_hash: EMPTY_CODE,
                random_seed: '',
                winnerhash: ''
            };
        });

        it('should return true if code is valid', () => {
            assert(check_match_verification(data));
        });

        it('should clean up options_hash', () => {
            check_match_verification(data);

            assert.equal(data.options_hash, '');
        });

        it('should move the verification to its own property', () => {
            check_match_verification(data);

            assert.equal(data.verification, EMPTY_CODE);
        });

        describe('allow network hash in either order', () => {
            const white_hash = 'ab';
            const black_hash = 'cd';

            beforeEach(() => {
                data.options_hash = ABCD_CODE;
            });

            it('should allow winner / loser', () => {
                data.winnerhash = black_hash;
                data.loserhash = white_hash;

                assert(check_match_verification(data));
            });

            it('should allow loser / winner', () => {
                data.loserhash = black_hash;
                data.winnerhash = white_hash;

                assert(check_match_verification(data));
            });
        });
    });
});
