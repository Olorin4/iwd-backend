// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import express from "express";
import Stripe from "stripe";
import { createInterimBillingRouter } from "../../src/interimBilling/routes.js";
import { interimBillingRawBody } from "../../src/interimBilling/webhook.js";
import { StaleApprovalError } from "../../src/interimBilling/runService.js";
let server, base, deps, config;
const token = "a".repeat(32);
beforeEach(async () => {
    config = {
        enabled: true,
        adminToken: token,
        mode: "sandbox",
        stripe: { webhookSecret: "whsec_fake" },
    };
    deps = {
        config,
        startRun: jest.fn().mockResolvedValue({ totalCents: 12000 }),
        approveRun: jest.fn(),
        chargeApprovedRun: jest.fn(),
        store: {
            getRun: jest.fn().mockResolvedValue({ id: 1 }),
            listInvoicesForRun: jest.fn().mockResolvedValue([]),
            listLinesForRun: jest.fn().mockResolvedValue([]),
        },
    };
    const app = express();
    app.use(express.json({ verify: interimBillingRawBody }));
    app.post("/echo", (req, res) => res.json(req.body));
    app.use(
        "/interim-billing",
        createInterimBillingRouter(
            () => config,
            () => deps
        )
    );
    await new Promise((resolve) => {
        server = app.listen(0, "127.0.0.1", resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise((resolve) => server.close(resolve)));
const request = (path, body = {}, auth = true, method = "POST") =>
    fetch(`${base}/interim-billing${path}`, {
        method,
        headers: {
            "Content-Type": "application/json",
            ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
it("protects every admin route and returns 404 when disabled", async () => {
    for (const path of [
        "/carriers",
        "/carriers/1/setup-link",
        "/runs",
        "/runs/1/approve",
        "/lines/1/linehaul",
        "/lines/1/decide",
    ]) {
        expect((await request(path, {}, false)).status).toBe(401);
        config.enabled = false;
        expect((await request(path)).status).toBe(404);
        config.enabled = true;
    }
    expect((await request("/runs/1", {}, false, "GET")).status).toBe(401);
});
it("runs and dry runs return summaries", async () => {
    expect(await (await request("/runs?dryRun=true")).json()).toEqual({
        totalCents: 12000,
    });
    expect(deps.startRun).toHaveBeenCalledWith(
        { now: expect.any(Date), dryRun: true },
        deps
    );
});
it("maps stale approval to 409 and rejects malformed amounts", async () => {
    deps.approveRun.mockRejectedValue(new StaleApprovalError());
    expect(
        (
            await request("/runs/1/approve", {
                invoiceCount: 1,
                totalCents: 12000,
            })
        ).status
    ).toBe(409);
    expect(
        (
            await request("/lines/1/linehaul", {
                amount: "abc",
                note: "confirmed",
            })
        ).status
    ).toBe(400);
});
it("verifies signed raw JSON through the app while parsing normal JSON", async () => {
    const stripe = new Stripe("sk_test_fake");
    Object.assign(deps, {
        stripe: {
            constructEvent: async (...args) =>
                stripe.webhooks.constructEvent(...args),
        },
        store: {
            withBillingLock: async (fn) => fn(),
            withTransaction: async (fn) => fn(),
            recordStripeEvent: jest.fn().mockResolvedValue(true),
        },
    });
    const payload = JSON.stringify({
        id: "evt_1",
        type: "unknown",
        livemode: false,
        data: { object: { id: "obj_1" } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_fake",
    });
    expect(
        (
            await fetch(`${base}/interim-billing/webhook`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "stripe-signature": signature,
                },
                body: payload,
            })
        ).status
    ).toBe(200);
    expect(
        await (
            await fetch(`${base}/echo`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: '{"ok":true}',
            })
        ).json()
    ).toEqual({ ok: true });
});
