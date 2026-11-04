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

const { prisma } = require("../src/prismaClient");
const { emailClient } = require("../src/emailService");
const router = require("../src/router").default;

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
        jest.spyOn(console, "error").mockImplementation(() => {});
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
                body: JSON.stringify(body),
            });

        it("stores a new subscriber and sends a welcome email", async () => {
            prisma.newsletterSubscriber.create.mockResolvedValue({ id: 1 });
            const res = await post({
                email: "Driver@Example.com",
                type: "newsletter",
            });
            expect(res.status).toBe(200);
            expect(prisma.newsletterSubscriber.create).toHaveBeenCalledWith({
                data: { email: "driver@example.com", source: "website" },
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
});
