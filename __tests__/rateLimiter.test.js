import express from "express";
import { createLimiter, limiter } from "../src/rateLimiter";

// Mirrors production: one trusted proxy hop (the nginx edge) that puts the
// real client IP last in X-Forwarded-For.
function startApp(rateLimiter) {
    const app = express();
    app.set("trust proxy", 1);
    app.use(rateLimiter);
    app.get("/health-check", (req, res) => res.json({ status: "OK" }));
    app.get("/thing", (req, res) => res.json({ ok: true }));
    return new Promise((resolve) => {
        const server = app.listen(0, "127.0.0.1", () =>
            resolve({
                server,
                base: `http://127.0.0.1:${server.address().port}`,
            })
        );
    });
}

const get = (base, path, forwardedFor) =>
    fetch(base + path, { headers: { "X-Forwarded-For": forwardedFor } });

describe("rate limiting behind one proxy hop", () => {
    let ctx;

    afterEach(() => new Promise((resolve) => ctx.server.close(resolve)));

    it("limits each client separately instead of sharing one budget", async () => {
        ctx = await startApp(createLimiter({ max: 2 }));
        expect((await get(ctx.base, "/thing", "10.0.0.1")).status).toBe(200);
        expect((await get(ctx.base, "/thing", "10.0.0.1")).status).toBe(200);
        expect((await get(ctx.base, "/thing", "10.0.0.1")).status).toBe(429);
        // A different visitor still has a full budget.
        expect((await get(ctx.base, "/thing", "10.0.0.2")).status).toBe(200);
    });

    it("cannot be evaded by sending a fake X-Forwarded-For prefix", async () => {
        ctx = await startApp(createLimiter({ max: 2 }));
        // The edge appends the real client IP, so the last entry is trusted.
        await get(ctx.base, "/thing", "6.6.6.6, 10.0.0.3");
        await get(ctx.base, "/thing", "7.7.7.7, 10.0.0.3");
        const third = await get(ctx.base, "/thing", "8.8.8.8, 10.0.0.3");
        expect(third.status).toBe(429);
    });

    it("never rate limits the health check", async () => {
        ctx = await startApp(limiter);
        for (let i = 0; i < 120; i++) {
            const res = await get(ctx.base, "/health-check", "10.0.0.4");
            expect(res.status).toBe(200);
        }
        // Real traffic from the same client is unaffected.
        expect((await get(ctx.base, "/thing", "10.0.0.4")).status).toBe(200);
    });

    it("counts each request once", async () => {
        ctx = await startApp(createLimiter({ max: 3 }));
        const first = await get(ctx.base, "/thing", "10.0.0.5");
        const second = await get(ctx.base, "/thing", "10.0.0.5");
        expect(first.headers.get("ratelimit-remaining")).toBe("2");
        expect(second.headers.get("ratelimit-remaining")).toBe("1");
    });
});
