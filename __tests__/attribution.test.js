import { attributionFields, OUTREACH_REF_PATTERN } from "../src/attribution.js";

function run(body) {
    const req = { body };
    const res = { locals: {} };
    const next = jest.fn();
    attributionFields(req, res, next);
    return { req, res, next };
}

describe("attributionFields", () => {
    it("keeps valid values", () => {
        const { req, res, next } = run({
            email: "a@b.co",
            outreachRef: "abcdefghijk2",
            posthogDistinctId: "0192-anon",
        });
        expect(res.locals.attribution).toEqual({
            outreachRef: "abcdefghijk2",
            posthogDistinctId: "0192-anon",
        });
        expect(req.body).not.toHaveProperty("outreachRef");
        expect(req.body).not.toHaveProperty("posthogDistinctId");
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("drops invalid values", () => {
        const { req, res, next } = run({
            outreachRef: "ABC",
            posthogDistinctId: "x".repeat(201),
        });
        expect(res.locals.attribution).toEqual({
            outreachRef: null,
            posthogDistinctId: null,
        });
        expect(req.body).not.toHaveProperty("outreachRef");
        expect(req.body).not.toHaveProperty("posthogDistinctId");
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("keeps a 200-character distinct id and drops an empty one", () => {
        const max = "x".repeat(200);
        expect(
            run({ posthogDistinctId: max }).res.locals.attribution
                .posthogDistinctId
        ).toBe(max);
        expect(
            run({ posthogDistinctId: "" }).res.locals.attribution
                .posthogDistinctId
        ).toBeNull();
    });

    it("drops non-string values", () => {
        let result;
        expect(() => {
            result = run({ outreachRef: 123, posthogDistinctId: { a: 1 } });
        }).not.toThrow();
        expect(result.res.locals.attribution).toEqual({
            outreachRef: null,
            posthogDistinctId: null,
        });
        expect(result.next).toHaveBeenCalledTimes(1);
    });

    it("captures the typed email before sanitizing", () => {
        const { req, res } = run({ email: "  John.Doe+X@Gmail.com " });
        expect(res.locals.identityEmail).toBe("john.doe+x@gmail.com");
        expect(req.body.email).toBe("  John.Doe+X@Gmail.com ");
    });

    it("sets a null identity email when the email is missing or not a string", () => {
        expect(run({}).res.locals.identityEmail).toBeNull();
        expect(run({ email: ["a@b.co"] }).res.locals.identityEmail).toBeNull();
        expect(run({ email: "   " }).res.locals.identityEmail).toBeNull();
    });

    it("copes with a missing body", () => {
        const { res, next } = run(undefined);
        expect(res.locals.identityEmail).toBeNull();
        expect(res.locals.attribution).toEqual({
            outreachRef: null,
            posthogDistinctId: null,
        });
        expect(next).toHaveBeenCalledTimes(1);
    });

    it("exports the outreach ref pattern", () => {
        expect(OUTREACH_REF_PATTERN.test("abcdefghijk2")).toBe(true);
        expect(OUTREACH_REF_PATTERN.test("abcdefghijk1")).toBe(false);
        expect(OUTREACH_REF_PATTERN.test("abcdefghijk2x")).toBe(false);
    });
});
