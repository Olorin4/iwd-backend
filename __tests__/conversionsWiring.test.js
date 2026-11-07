import express from "express";
import { registerShutdown } from "../src/shutdown";

jest.mock("../src/prismaClient", () => ({
    prisma: {
        signUpForm: { create: jest.fn() },
        contactSubmission: { create: jest.fn() },
        newsletterSubscriber: { create: jest.fn() },
    },
}));
jest.mock("../src/emailService", () => ({
    emailClient: jest.fn().mockResolvedValue(true),
    emailAdmin: jest.fn().mockResolvedValue(true),
}));
jest.mock("../src/rateLimiter", () => ({
    newsletterLimiter: (req, res, next) => next(),
}));
// Never send real PostHog events or Outreach webhooks from these tests.
jest.mock("../src/conversions", () => ({
    recordConversion: jest.fn(),
}));
jest.mock("../src/logging", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const { prisma } = require("../src/prismaClient");
const { recordConversion } = require("../src/conversions");
const { logger } = require("../src/logging");
const router = require("../src/router").default;

const realFetch = global.fetch;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const FORMS = [
    [
        "/sign-up-forms",
        "signUpForm",
        {
            firstName: "A",
            lastName: "B",
            email: "a@example.com",
            fleetSize: "3",
            trailerType: "Reefer",
            plan: "Basic",
        },
        { message: "Form submitted successfully!", id: 5 },
    ],
    [
        "/contact-forms",
        "contactSubmission",
        { email: "a@example.com", message: "hi" },
        { message: "Contact form submitted successfully!", id: 5 },
    ],
    [
        "/newsletter",
        "newsletterSubscriber",
        { email: "a@example.com" },
        { message: "Subscribed successfully!" },
    ],
];

describe("conversion wiring", () => {
    let server;
    let base;

    beforeAll(async () => {
        const app = express();
        app.use(express.json());
        app.use(router);
        await new Promise((resolve) => {
            server = app.listen(0, "127.0.0.1", resolve);
        });
        base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
        jest.spyOn(console, "log").mockImplementation(() => {});
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(global, "fetch").mockImplementation((url, options) =>
            String(url) === SITEVERIFY
                ? Promise.resolve({
                      ok: true,
                      json: async () => ({ success: true }),
                  })
                : realFetch(url, options)
        );
    });

    afterEach(() => {
        global.fetch.mockRestore();
        jest.restoreAllMocks();
    });

    const post = (path, body) =>
        fetch(base + path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ turnstileToken: "valid-token", ...body }),
        });

    describe.each(FORMS)("POST %s", (path, model, payload, expected) => {
        it("a rejected recordConversion does not change the response", async () => {
            prisma[model].create.mockResolvedValue({ id: 5 });
            recordConversion.mockRejectedValue(new Error("analytics down"));
            const res = await post(path, payload);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(expected);
            await new Promise((r) => setImmediate(r));
            expect(recordConversion).toHaveBeenCalledTimes(1);
            expect(logger.error).toHaveBeenCalledWith(
                "Conversion recording failed",
                { error: "analytics down" }
            );
        });

        it("a recordConversion that throws does not change the response", async () => {
            prisma[model].create.mockResolvedValue({ id: 5 });
            recordConversion.mockImplementation(() => {
                throw new Error("analytics exploded");
            });
            const res = await post(path, payload);
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual(expected);
            expect(logger.error).toHaveBeenCalledWith(
                "Conversion recording failed",
                { error: "analytics exploded" }
            );
        });

        it("answers without waiting for the conversion", async () => {
            prisma[model].create.mockResolvedValue({ id: 5 });
            recordConversion.mockReturnValue(new Promise(() => {}));
            const res = await post(path, payload);
            expect(res.status).toBe(200);
            expect(recordConversion).toHaveBeenCalledTimes(1);
        });
    });
});

describe("registerShutdown", () => {
    function fakeProc() {
        const handlers = {};
        return {
            handlers,
            on: jest.fn((signal, fn) => {
                handlers[signal] = fn;
            }),
            exit: jest.fn(),
        };
    }

    it("app flushes PostHog on SIGTERM", async () => {
        const proc = fakeProc();
        const order = [];
        const shutdownFn = jest.fn(async () => {
            await new Promise((r) => setImmediate(r));
            order.push("flushed");
        });
        proc.exit.mockImplementation(() => order.push("exit"));

        registerShutdown(proc, shutdownFn);
        await proc.handlers.SIGTERM();

        expect(shutdownFn).toHaveBeenCalledTimes(1);
        expect(proc.exit).toHaveBeenCalledWith(0);
        expect(order).toEqual(["flushed", "exit"]);
    });

    it("also flushes on SIGINT", async () => {
        const proc = fakeProc();
        const shutdownFn = jest.fn().mockResolvedValue(undefined);
        registerShutdown(proc, shutdownFn);
        await proc.handlers.SIGINT();
        expect(shutdownFn).toHaveBeenCalledTimes(1);
        expect(proc.exit).toHaveBeenCalledWith(0);
    });

    it("still exits when the flush fails", async () => {
        const proc = fakeProc();
        const shutdownFn = jest.fn().mockRejectedValue(new Error("flush"));
        registerShutdown(proc, shutdownFn);
        await proc.handlers.SIGTERM();
        expect(proc.exit).toHaveBeenCalledWith(0);
    });
});
