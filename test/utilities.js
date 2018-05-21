const {
    set_task_verification_secret,
    compute_task_verification,
    add_match_verification,
    check_match_verification,
    make_seed,
    get_timestamp_from_seed,
    network_exists,
    asyncMiddleware,
    SPRT
} = require("../classes/utilities.js");
const assert = require("assert");
const crypto = require("crypto");
const { Long } = require("mongodb");

describe("Utilities", () => {
    describe("#network_exists(hash)", () => {
        const hash = crypto.randomBytes(256 / 8).toString("hex");

        const tests = [
            { description: "should return false for random hash (" + hash + ")", input: hash, expect: false },
            { description: "should return false for null input", input: null, expect: false }
        ];

        tests.forEach(test => it(test.description, () => assert.equal(network_exists(test.input), test.expect)));
    });

    describe("#asyncMiddleware()", () => {
        it("should catch error and pass it to the next() handler", async() => {
            const intendedError = new Error("intended error");

            asyncMiddleware(async() => {
                throw intendedError;
            })(null, null, err => assert.equal(intendedError, err));
        });
    });

    describe("#SPRT(w, l)", () => {
        it("should not be true for games <= 100", () => {
            for (let l = 0; l <= 100; l++) {
                for (let w = 0; w + l <= 100; w++) {
                    assert.notEqual(SPRT(w, l), true);
                }
            }
        });

        it("should not be false for win = 220 and games <= 400", () => {
            const w = 220;
            for (let l = 0; l <= 400 - w; l++) {
                assert.notEqual(SPRT(w, l), false);
            }
        });

        it("should not be true for lose = 181 and games <= 400", () => {
            const l = 181;
            for (let w = 0; w <= 400 - l; w++) {
                assert.notEqual(SPRT(w, l), true);
            }
        });
    });
});

describe("Task Verification", () => {
    const EMPTY_CODE = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const ABCD_CODE = "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589";
    const CDAB_CODE = "b7caca69b8597456e5db1676b6e6f930527f14c452bf4454a1398c40dc04ee78";

    afterEach(() => set_task_verification_secret(""));

    describe("#set_task_verification_secret(secret)", () => {
        it("should use a default secret", () => {
            const code = compute_task_verification("");

            assert.equal(code, EMPTY_CODE);
        });

        it("should have a default empty string secret", () => {
            set_task_verification_secret("");
            const code = compute_task_verification("");

            assert.equal(code, EMPTY_CODE);
        });

        it("should change secrets", () => {
            set_task_verification_secret("abcd");
            const code = compute_task_verification("");

            assert.equal(code, ABCD_CODE);
        });

        it("should use the latest secret", () => {
            set_task_verification_secret("abcd");
            set_task_verification_secret("cdab");
            const code = compute_task_verification("");

            assert.equal(code, CDAB_CODE);
        });
    });

    describe("#compute_task_verification(seed)", () => {
        it("should compute a code with empty", () => {
            const code = compute_task_verification("");

            assert.equal(code, EMPTY_CODE);
        });

        it("should compute a code with strings", () => {
            const code = compute_task_verification("abcd");

            assert.equal(code, ABCD_CODE);
        });

        it("should compute a code with numbers", () => {
            const code = compute_task_verification(1234);

            assert.equal(code, "03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4");
        });
    });

    describe("#add_match_verification(task)", () => {
        it("should append code to options_hash", () => {
            const options_hash = "abcd";
            const task = {
                black_hash: "",
                options_hash,
                random_seed: "",
                white_hash: ""
            };

            add_match_verification(task);

            assert.equal(task.options_hash, options_hash + EMPTY_CODE);
        });
    });

    describe("#check_match_verification(data)", () => {
        let data;
        beforeEach(() => {
            data = {
                loserhash: "",
                options_hash: EMPTY_CODE,
                random_seed: "",
                winnerhash: ""
            };
        });

        it("should return true if code is valid", () => {
            assert(check_match_verification(data));
        });

        it("should clean up options_hash", () => {
            check_match_verification(data);

            assert.equal(data.options_hash, "");
        });

        it("should move the verification to its own property", () => {
            check_match_verification(data);

            assert.equal(data.verification, EMPTY_CODE);
        });

        describe("allow network hash in either order", () => {
            const white_hash = "ab";
            const black_hash = "cd";

            beforeEach(() => {
                data.options_hash = ABCD_CODE;
            });

            it("should allow winner / loser", () => {
                data.winnerhash = black_hash;
                data.loserhash = white_hash;

                assert(check_match_verification(data));
            });

            it("should allow loser / winner", () => {
                data.loserhash = black_hash;
                data.winnerhash = white_hash;

                assert(check_match_verification(data));
            });
        });
    });
});

describe("Seed", () => {
    describe("#make_seed(seconds, highBits)", () => {
        it("should make something with defaults", () => {
            assert(make_seed());
        });

        it("should use current time by default", () => {
            const now = Date.now() / 1000;
            const s1 = make_seed();
            const s2 = make_seed(now);

            assert.equal(s1.getLowBits(), s2.getLowBits());
        });

        it("should not make negative seeds by default", () => {
            for (let i = 0; i < 100; i++)
                assert.notEqual(make_seed().toString()[0], "-");
        });

        it("should take custom high bits", () => {
            const low = 123;
            const high = 890;

            const seed = make_seed(low, high);

            assert.equal(seed.getLowBits(), low);
            assert.equal(seed.getHighBits(), high);
        });

        it("should allow full 64-bit seeds", () => {
            const seed = make_seed(0, 4294967295);

            assert.equal(seed.toString()[0], "-");
        });
    });

    describe("#get_timestamp_from_seed(seed)", () => {
        it("should extract the timestamp", () => {
            const seed = Long.fromString("1719949479461840638");
            const ts = get_timestamp_from_seed(seed);

            assert.equal(ts, 1525737214);
        });

        it("should work for existing seeds (non-sensical timestamp)", () => {
            const seed = Long.fromString("1324276254195649245");
            const ts = get_timestamp_from_seed(seed);

            assert.equal(ts, 2748386013);
        });
    });
});
