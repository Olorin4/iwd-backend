import { requireTurnstile, SITEVERIFY_URL } from "../src/turnstile";

function makeRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

const ok = (data) => ({ ok: true, status: 200, json: async () => data });

describe("requireTurnstile", () => {
    beforeEach(() => {
        process.env.TURNSTILE_SECRET_KEY = "secret-123";
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        global.fetch = jest.fn().mockResolvedValue(ok({ success: true }));
    });

    afterEach(() => {
        delete global.fetch;
        jest.restoreAllMocks();
    });

    it("calls siteverify with the secret, token and client IP, then continues", async () => {
        const req = {
            body: { turnstileToken: "tok", email: "a@b.co" },
            ip: "203.0.113.9",
        };
        const res = makeRes();
        const next = jest.fn();

        await requireTurnstile(req, res, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(res.status).not.toHaveBeenCalled();
        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe(SITEVERIFY_URL);
        expect(options.method).toBe("POST");
        expect(Object.fromEntries(options.body)).toEqual({
            secret: "secret-123",
            response: "tok",
            remoteip: "203.0.113.9",
        });
    });

    it("removes the token from the body so it is never logged or stored", async () => {
        const req = { body: { turnstileToken: "tok", email: "a@b.co" } };
        await requireTurnstile(req, makeRes(), jest.fn());
        expect(req.body).toEqual({ email: "a@b.co" });
    });

    it("removes the token even when the check fails", async () => {
        global.fetch.mockResolvedValue(ok({ success: false }));
        const req = { body: { turnstileToken: "tok", email: "a@b.co" } };
        await requireTurnstile(req, makeRes(), jest.fn());
        expect(req.body).toEqual({ email: "a@b.co" });
    });

    it.each([
        ["missing", undefined],
        ["empty", ""],
        ["not a string", { $ne: "" }],
        ["over 2048 characters", "x".repeat(2049)],
    ])(
        "rejects a %s token with 403 and never calls Cloudflare",
        async (_label, token) => {
            const res = makeRes();
            const next = jest.fn();
            await requireTurnstile(
                { body: { turnstileToken: token } },
                res,
                next
            );
            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
            expect(global.fetch).not.toHaveBeenCalled();
        }
    );

    it("tolerates a request with no body", async () => {
        const res = makeRes();
        await requireTurnstile({}, res, jest.fn());
        expect(res.status).toHaveBeenCalledWith(403);
    });

    it("rejects with 403 when Cloudflare reports failure", async () => {
        global.fetch.mockResolvedValue(
            ok({ success: false, "error-codes": ["timeout-or-duplicate"] })
        );
        const res = makeRes();
        const next = jest.fn();
        await requireTurnstile({ body: { turnstileToken: "used" } }, res, next);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(next).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when siteverify returns a server error", async () => {
        global.fetch.mockResolvedValue({
            ok: false,
            status: 500,
            json: async () => ({}),
        });
        const res = makeRes();
        const next = jest.fn();
        await requireTurnstile({ body: { turnstileToken: "tok" } }, res, next);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when siteverify is unreachable", async () => {
        global.fetch.mockRejectedValue(new Error("ECONNRESET"));
        const res = makeRes();
        const next = jest.fn();
        await requireTurnstile({ body: { turnstileToken: "tok" } }, res, next);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
    });

    it("fails closed with 503 when the secret is not configured", async () => {
        delete process.env.TURNSTILE_SECRET_KEY;
        const res = makeRes();
        const next = jest.fn();
        await requireTurnstile({ body: { turnstileToken: "tok" } }, res, next);
        expect(res.status).toHaveBeenCalledWith(503);
        expect(next).not.toHaveBeenCalled();
        expect(global.fetch).not.toHaveBeenCalled();
    });

    it("does not treat an error thrown by a later handler as a verification failure", async () => {
        const res = makeRes();
        const next = jest.fn(() => {
            throw new Error("downstream bug");
        });
        await expect(
            requireTurnstile({ body: { turnstileToken: "tok" } }, res, next)
        ).rejects.toThrow("downstream bug");
        expect(res.status).not.toHaveBeenCalled();
    });
});
