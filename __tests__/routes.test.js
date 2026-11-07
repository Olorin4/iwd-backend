import express from "express";

jest.mock("../src/prismaClient", () => ({
    prisma: {
        signUpForm: { findMany: jest.fn(), create: jest.fn() },
        contactSubmission: { findMany: jest.fn(), create: jest.fn() },
        newsletterSubscriber: { create: jest.fn() },
    },
}));
jest.mock("../src/emailService", () => ({
    emailClient: jest.fn().mockResolvedValue(true),
    emailAdmin: jest.fn().mockResolvedValue(true),
}));

// Never send real PostHog events or Outreach webhooks from these tests.
jest.mock("../src/conversions", () => ({
    recordConversion: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/logging", () => ({
    logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// The newsletter limiter allows 10 requests per IP per hour and every test here
// comes from one IP, so a pass-through keeps the suite independent of how many
// newsletter requests it makes. The limiter has its own tests in
// rateLimiter.test.js.
jest.mock("../src/rateLimiter", () => ({
    newsletterLimiter: (req, res, next) => next(),
}));

// Wrap the real middleware so the tests can see when it runs and what the
// request body looked like at that point.
const mockAttributionSeen = [];
jest.mock("../src/attribution", () => {
    const actual = jest.requireActual("../src/attribution");
    return {
        ...actual,
        attributionFields: jest.fn((req, res, next) => {
            mockAttributionSeen.push({ ...req.body });
            return actual.attributionFields(req, res, next);
        }),
    };
});

const { prisma } = require("../src/prismaClient");
const { attributionFields } = require("../src/attribution");
const { emailClient } = require("../src/emailService");
const { recordConversion } = require("../src/conversions");
const router = require("../src/router").default;

// The tests use global fetch as their HTTP client, so Cloudflare's siteverify
// call is intercepted here and everything else passes through untouched.
const realFetch = global.fetch;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
let siteverify;

describe("routes", () => {
    let server;
    let base;
    const TOKEN = "test-admin-token";

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
        process.env.ADMIN_API_TOKEN = TOKEN;
        process.env.TURNSTILE_SECRET_KEY = "test-turnstile-secret";
        jest.spyOn(console, "error").mockImplementation(() => {});
        jest.spyOn(console, "warn").mockImplementation(() => {});
        jest.spyOn(console, "log").mockImplementation(() => {});
        recordConversion.mockResolvedValue(undefined);
        siteverify = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ success: true }),
        });
        jest.spyOn(global, "fetch").mockImplementation((url, options) =>
            String(url) === SITEVERIFY
                ? siteverify(url, options)
                : realFetch(url, options)
        );
    });

    afterEach(() => {
        global.fetch.mockRestore();
    });

    describe.each([
        ["/sign-up-forms", { email: "a@example.com", firstName: "A" }],
        ["/contact-forms", { email: "a@example.com", message: "hi" }],
        ["/newsletter", { email: "a@example.com" }],
    ])("Turnstile enforcement on POST %s", (path, payload) => {
        const post = (body) =>
            fetch(base + path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
        const nothingStored = () => {
            expect(prisma.signUpForm.create).not.toHaveBeenCalled();
            expect(prisma.contactSubmission.create).not.toHaveBeenCalled();
            expect(prisma.newsletterSubscriber.create).not.toHaveBeenCalled();
            expect(emailClient).not.toHaveBeenCalled();
            expect(recordConversion).not.toHaveBeenCalled();
        };

        it("rejects a request with no token without calling Cloudflare", async () => {
            const res = await post(payload);
            expect(res.status).toBe(403);
            expect(siteverify).not.toHaveBeenCalled();
            nothingStored();
        });

        it("rejects a token Cloudflare says is invalid", async () => {
            siteverify.mockResolvedValue({
                ok: true,
                json: async () => ({
                    success: false,
                    "error-codes": ["invalid-input-response"],
                }),
            });
            const res = await post({ ...payload, turnstileToken: "bad" });
            expect(res.status).toBe(403);
            nothingStored();
        });

        it("fails closed when Cloudflare cannot be reached", async () => {
            siteverify.mockRejectedValue(new Error("network down"));
            const res = await post({ ...payload, turnstileToken: "tok" });
            expect(res.status).toBe(503);
            nothingStored();
        });

        it("fails closed when the secret is not configured", async () => {
            delete process.env.TURNSTILE_SECRET_KEY;
            const res = await post({ ...payload, turnstileToken: "tok" });
            expect(res.status).toBe(503);
            expect(siteverify).not.toHaveBeenCalled();
            nothingStored();
        });
    });

    describe.each([
        ["/sign-up-forms", { email: "A.B+x@Gmail.com", firstName: "A" }],
        ["/contact-forms", { email: "A.B+x@Gmail.com", message: "hi" }],
        ["/newsletter", { email: "A.B+x@Gmail.com" }],
    ])("attributionFields on POST %s", (path, payload) => {
        const post = (body) =>
            fetch(base + path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

        beforeEach(() => {
            attributionFields.mockClear();
            mockAttributionSeen.length = 0;
        });

        it("never runs when Turnstile rejects the request", async () => {
            const res = await post({ ...payload, outreachRef: "abcdefghijk2" });
            expect(res.status).toBe(403);
            expect(attributionFields).not.toHaveBeenCalled();
        });

        it("runs after requireTurnstile and before the validators", async () => {
            // The invalid email still reaches the middleware, and the 400
            // proves a validator ran after it.
            const res = await post({
                ...payload,
                email: "not-an-email",
                turnstileToken: "valid-token",
            });
            expect(res.status).toBe(400);
            expect(attributionFields).toHaveBeenCalledTimes(1);
            // After requireTurnstile (token already removed) ...
            expect(mockAttributionSeen[0]).not.toHaveProperty("turnstileToken");
            // ... and before any sanitizer (email still as typed).
            expect(mockAttributionSeen[0].email).toBe("not-an-email");
        });

        it("sees the email before the sanitizers rewrite it", async () => {
            await post({ ...payload, turnstileToken: "valid-token" });
            expect(attributionFields).toHaveBeenCalledTimes(1);
            expect(mockAttributionSeen[0].email).toBe("A.B+x@Gmail.com");
        });
    });

    describe.each([
        ["/sign-up-forms", "signUpForm"],
        ["/contact-forms", "contactSubmission"],
    ])("GET %s", (path, model) => {
        it("rejects requests without a token", async () => {
            const res = await fetch(base + path);
            expect(res.status).toBe(401);
            expect(prisma[model].findMany).not.toHaveBeenCalled();
        });

        it("rejects a wrong token", async () => {
            const res = await fetch(base + path, {
                headers: { Authorization: "Bearer nope" },
            });
            expect(res.status).toBe(401);
            expect(prisma[model].findMany).not.toHaveBeenCalled();
        });

        it("rejects every request when no admin token is configured", async () => {
            delete process.env.ADMIN_API_TOKEN;
            const res = await fetch(base + path, {
                headers: { Authorization: "Bearer undefined" },
            });
            expect(res.status).toBe(401);
            expect(prisma[model].findMany).not.toHaveBeenCalled();
        });

        it("returns records for the right token", async () => {
            prisma[model].findMany.mockResolvedValue([{ id: 1 }]);
            const res = await fetch(base + path, {
                headers: { Authorization: `Bearer ${TOKEN}` },
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual([{ id: 1 }]);
        });
    });

    describe("POST /newsletter", () => {
        const post = (body) =>
            fetch(`${base}/newsletter`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    turnstileToken: "valid-token",
                    ...body,
                }),
            });

        it("stores a new subscriber and sends a welcome email", async () => {
            prisma.newsletterSubscriber.create.mockResolvedValue({ id: 1 });
            const res = await post({
                email: "Driver@Example.com",
                type: "newsletter",
            });
            expect(res.status).toBe(200);
            expect(prisma.newsletterSubscriber.create).toHaveBeenCalledWith({
                data: {
                    email: "driver@example.com",
                    source: "website",
                    outreach_ref: null,
                    posthog_distinct_id: null,
                },
            });
            await new Promise((r) => setImmediate(r));
            expect(emailClient).toHaveBeenCalledTimes(1);
        });

        it("answers the same way for an existing subscriber without emailing", async () => {
            prisma.newsletterSubscriber.create.mockRejectedValue({
                code: "P2002",
            });
            const res = await post({ email: "driver@example.com" });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                message: "Subscribed successfully!",
            });
            await new Promise((r) => setImmediate(r));
            expect(emailClient).not.toHaveBeenCalled();
        });

        it("rejects an invalid email", async () => {
            const res = await post({ email: "not-an-email" });
            expect(res.status).toBe(400);
            expect(prisma.newsletterSubscriber.create).not.toHaveBeenCalled();
        });

        it("rejects a missing email", async () => {
            const res = await post({});
            expect(res.status).toBe(400);
        });

        it("returns 500 without leaking details on a database error", async () => {
            prisma.newsletterSubscriber.create.mockRejectedValue(
                new Error("connection refused at 10.0.0.5")
            );
            const res = await post({ email: "driver@example.com" });
            expect(res.status).toBe(500);
            expect(await res.json()).toEqual({
                error: "Internal Server Error",
            });
        });
    });

    describe("POST /contact-forms", () => {
        const post = (body) =>
            fetch(`${base}/contact-forms`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    turnstileToken: "valid-token",
                    ...body,
                }),
            });

        it("saves a contact without attribution fields", async () => {
            prisma.contactSubmission.create.mockResolvedValue({ id: 11 });
            const res = await post({
                email: "Carrier@Example.com",
                message: "hello",
            });
            expect(res.status).toBe(200);
            expect(prisma.contactSubmission.create).toHaveBeenCalledWith({
                data: {
                    email: "carrier@example.com",
                    // The sanitizer turns a missing phone into "".
                    phone: "",
                    message: "hello",
                    outreach_ref: null,
                    posthog_distinct_id: null,
                },
            });
            await new Promise((r) => setImmediate(r));
            expect(recordConversion).toHaveBeenCalledTimes(1);
            expect(recordConversion).toHaveBeenCalledWith({
                type: "contact",
                leadId: 11,
                identityEmail: "carrier@example.com",
                attribution: { outreachRef: null, posthogDistinctId: null },
                properties: { has_phone: false },
            });
        });

        it("stores the attribution fields on a contact", async () => {
            prisma.contactSubmission.create.mockResolvedValue({ id: 12 });
            const res = await post({
                email: "carrier@example.com",
                phone: "555-0100",
                message: "hello",
                outreachRef: "abcdefghijk2",
                posthogDistinctId: "anon-1",
            });
            expect(res.status).toBe(200);
            expect(prisma.contactSubmission.create).toHaveBeenCalledWith({
                data: expect.objectContaining({
                    outreach_ref: "abcdefghijk2",
                    posthog_distinct_id: "anon-1",
                }),
            });
            expect(recordConversion).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: "contact",
                    attribution: {
                        outreachRef: "abcdefghijk2",
                        posthogDistinctId: "anon-1",
                    },
                    properties: { has_phone: true },
                })
            );
        });

        it("contact never saves unknown body keys", async () => {
            prisma.contactSubmission.create.mockResolvedValue({ id: 13 });
            const res = await post({
                email: "carrier@example.com",
                phone: "555-0100",
                message: "hello",
                id: 999,
                status: "won",
                created_at: "2001-01-01",
            });
            expect(res.status).toBe(200);
            const { data } = prisma.contactSubmission.create.mock.calls[0][0];
            expect(Object.keys(data).sort()).toEqual([
                "email",
                "message",
                "outreach_ref",
                "phone",
                "posthog_distinct_id",
            ]);
        });

        it("records nothing when the database fails", async () => {
            prisma.contactSubmission.create.mockRejectedValue(new Error("db"));
            const res = await post({
                email: "carrier@example.com",
                message: "hello",
            });
            expect(res.status).toBe(500);
            await new Promise((r) => setImmediate(r));
            expect(recordConversion).not.toHaveBeenCalled();
        });

        it("validation failure records nothing", async () => {
            const res = await post({ email: "nope", message: "hello" });
            expect(res.status).toBe(400);
            expect(prisma.contactSubmission.create).not.toHaveBeenCalled();
            expect(recordConversion).not.toHaveBeenCalled();
        });
    });

    describe("newsletter conversions", () => {
        const post = (body) =>
            fetch(`${base}/newsletter`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    turnstileToken: "valid-token",
                    ...body,
                }),
            });

        it("newsletter new subscriber records a conversion", async () => {
            prisma.newsletterSubscriber.create.mockResolvedValue({ id: 21 });
            const res = await post({
                email: "Driver@Example.com",
                outreachRef: "abcdefghijk2",
                posthogDistinctId: "anon-2",
            });
            expect(res.status).toBe(200);
            expect(prisma.newsletterSubscriber.create).toHaveBeenCalledWith({
                data: {
                    email: "driver@example.com",
                    source: "website",
                    outreach_ref: "abcdefghijk2",
                    posthog_distinct_id: "anon-2",
                },
            });
            await new Promise((r) => setImmediate(r));
            expect(recordConversion).toHaveBeenCalledTimes(1);
            expect(recordConversion).toHaveBeenCalledWith({
                type: "newsletter",
                leadId: 21,
                identityEmail: "driver@example.com",
                attribution: {
                    outreachRef: "abcdefghijk2",
                    posthogDistinctId: "anon-2",
                },
                properties: {},
            });
        });

        it("newsletter repeat (P2002) records nothing and stays 200", async () => {
            prisma.newsletterSubscriber.create.mockRejectedValue({
                code: "P2002",
            });
            const res = await post({
                email: "driver@example.com",
                outreachRef: "abcdefghijk2",
            });
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({
                message: "Subscribed successfully!",
            });
            await new Promise((r) => setImmediate(r));
            expect(recordConversion).not.toHaveBeenCalled();
            // Only create() was attempted; the existing row is never updated.
            expect(Object.keys(prisma.newsletterSubscriber)).toEqual([
                "create",
            ]);
        });

        it("validation failure records nothing", async () => {
            const res = await post({ email: "not-an-email" });
            expect(res.status).toBe(400);
            expect(recordConversion).not.toHaveBeenCalled();
        });
    });
});
