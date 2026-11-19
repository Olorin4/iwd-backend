import { prisma } from "../../src/prismaClient";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import { kelevoProvisioningStub } from "../../src/onboarding/provisioning/adapters";
import { deliverPending } from "../../src/onboarding/outbox";
import {
    reconcileOnce,
    startOnboardingWorkers,
} from "../../src/onboarding/workers";
import { verifySignature } from "../../src/onboarding/signing";
import { onboardingStatusV1 } from "../../src/onboarding/contracts";
import {
    BUNDLE,
    SIGNING,
    TOKEN,
    approveTestBundle,
    captureLogger,
    cleanTables,
    deleteBundles,
    fixture,
    requestBody,
    serializeSuite,
    startApp,
    taskQueue,
    tempDir,
    testConfig,
} from "./harness";
import { makeSyntheticPacket, syntheticLayout } from "./pdfFixtures";
import { createFakeStripe, stripeEvent } from "./fakeStripe";

serializeSuite();

const KEY = fixture("onboarding.request.v1").idempotency_key;
const ACTOR = {
    user_id: "55555555-5555-4555-8555-555555555555",
    email: "closer@example.test",
};
const OUTBOX = {
    enabled: true,
    url: "https://outreach.example.test/internal/sales/onboarding-status",
    token: "o".repeat(40),
    signingSecret: "h".repeat(40),
    intervalMs: 30000,
};
let app, deps, config, queue, signature, stripe, sendEmail;

function build(overrides = {}) {
    config = testConfig(tempDir(), { outbox: OUTBOX, ...overrides.config });
    queue = taskQueue();
    signature = createFakeSignatureProvider();
    stripe = createFakeStripe();
    sendEmail = jest.fn().mockResolvedValue({});
    deps = createOnboardingDeps(config, {
        db: prisma,
        logger: captureLogger(),
        sendEmail,
        signature,
        stripe,
        schedule: queue.schedule,
        ...overrides.deps,
    });
}

beforeEach(async () => {
    await cleanTables(prisma);
    build();
    await approveTestBundle(prisma, deps.documentStore, {
        makePacket: makeSyntheticPacket,
        layout: syntheticLayout(),
    });
    app = await startApp(
        () => config,
        () => deps
    );
});
afterEach(() => app.close());
afterAll(async () => {
    await cleanTables(prisma);
    await deleteBundles(prisma, BUNDLE);
});

const request = () =>
    prisma.onboardingRequest.findUnique({ where: { idempotency_key: KEY } });
// Distinct timestamps so identical bodies are not treated as replays.
let tick = 0;
const action = (name, body = {}) =>
    app.call(
        "POST",
        `/requests/${KEY}/actions/${name}`,
        { actor: ACTOR, ...body },
        { nowSeconds: Math.floor(Date.now() / 1000) - 100 - (tick++ % 150) }
    );

async function toPaymentReady() {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const [envelope] = await prisma.signatureEnvelope.findMany();
    signature.complete(envelope.provider_document_id);
    await deps.reconcileSignature(envelope.request_id);
    await queue.drain();
    const [setup] = await prisma.paymentSetup.findMany();
    stripe.complete(setup.checkout_session_id);
    const event = stripeEvent(config.stripe.webhookSecret, {
        type: "checkout.session.completed",
        object: { id: setup.checkout_session_id },
    });
    await app.call("POST", "/webhooks/stripe", event.payload, {
        auth: false,
        headers: { "Stripe-Signature": event.header },
    });
    await queue.drain();
    return request();
}

it("runs end to end: manual provisioning, confirm, checklist → READY and Client ACTIVE", async () => {
    let row = await toPaymentReady();
    expect(row).toMatchObject({
        payment_state: "READY",
        provisioning_state: "MANUAL_REQUIRED",
        provisioning_code: "manual_provisioning_required",
    });
    let status = (await app.call("GET", `/requests/${KEY}`)).json;
    expect(status).toMatchObject({
        readiness: "BLOCKED",
        blocked: {
            code: "manual_provisioning_required",
            action: "confirm_provisioning",
        },
    });
    expect((await action("confirm_provisioning", {})).status).toBe(422);
    const confirmed = await action("confirm_provisioning", {
        kelevo_ref: "KEL-CARRIER-42",
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.json).toMatchObject({
        provisioning: {
            state: "MANUAL_CONFIRMED",
            kelevo_ref: "KEL-CARRIER-42",
        },
    });
    for (const key of [
        "AUTHORITY_VERIFIED",
        "INSURANCE_COI",
        "W9",
        "NOT_FACTORING",
        "CARRIER_PROFILE",
    ])
        expect((await action("verify_operation_item", { key })).status).toBe(
            200
        );
    expect(
        (await action("confirm_load_board_access", { boards: ["DAT_ONE"] }))
            .status
    ).toBe(200);
    expect((await app.call("GET", `/requests/${KEY}`)).json.readiness).toBe(
        "IN_PROGRESS"
    );
    const last = await action("verify_operation_item", {
        key: "FLEET_MAPPING",
        note: "2 trucks mapped",
    });
    expect(onboardingStatusV1.parse(last.json)).toMatchObject({
        readiness: "READY",
        operations: { state: "COMPLETE" },
    });
    const client = await prisma.client.findFirst();
    expect(client).toMatchObject({
        status: "ACTIVE",
        kelevo_ref: "KEL-CARRIER-42",
    });
    // Every facet change wrote one status event with a strictly increasing version.
    row = await request();
    const events = await prisma.onboardingEvent.findMany({
        where: { type: "onboarding.status.v1" },
        orderBy: { version: "asc" },
    });
    expect(events.map((e) => e.version)).toEqual(
        Array.from({ length: row.version }, (_, i) => i + 1)
    );
    expect(events.at(-1).payload.readiness).toBe("READY");
    for (const event of events)
        expect(onboardingStatusV1.safeParse(event.payload).success).toBe(true);
    // Actions are audited with their actor.
    const audits = await prisma.onboardingEvent.findMany({
        where: { type: { startsWith: "audit.action." } },
    });
    // confirm + six checklist items + load board access (the 422 never
    // reached a request).
    expect(audits.length).toBe(8);
    expect(audits.every((a) => a.payload.actor.email === ACTOR.email)).toBe(
        true
    );
    expect(
        audits.some((a) => a.payload.outcome === "provisioning_confirmed")
    ).toBe(true);
});

it("the Kelevo adapter stub returns MANUAL_REQUIRED with kelevo_api_unavailable; retry stays manual", async () => {
    deps.provisioning = kelevoProvisioningStub;
    await toPaymentReady();
    expect(await request()).toMatchObject({
        provisioning_state: "MANUAL_REQUIRED",
        provisioning_code: "kelevo_api_unavailable",
    });
    expect((await action("retry_provisioning")).status).toBe(200);
    expect((await request()).provisioning_state).toBe("MANUAL_REQUIRED");
});

it("actions require service auth and an actor, refuse replays and disallowed transitions", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    expect(
        (
            await app.call(
                "POST",
                `/requests/${KEY}/actions/reconcile`,
                { actor: ACTOR },
                { auth: false }
            )
        ).status
    ).toBe(401);
    expect(
        (await app.call("POST", `/requests/${KEY}/actions/reconcile`, {}))
            .status
    ).toBe(422);
    expect(
        (
            await app.call("POST", `/requests/${KEY}/actions/bogus`, {
                actor: ACTOR,
            })
        ).status
    ).toBe(404);
    // Every accepted v2 signature is recorded; presenting it again inside the
    // window is refused.
    const body = { actor: ACTOR };
    const t = Math.floor(Date.now() / 1000) - 5;
    expect(
        (
            await app.call("POST", `/requests/${KEY}/actions/reconcile`, body, {
                nowSeconds: t,
                nonce: "e".repeat(32),
            })
        ).status
    ).toBe(200);
    const replay = await app.call(
        "POST",
        `/requests/${KEY}/actions/reconcile`,
        body,
        { nowSeconds: t, nonce: "e".repeat(32) }
    );
    expect(replay).toMatchObject({
        status: 401,
        json: { error: "replayed_signature" },
    });
    const refused = await action("resend_payment_link");
    expect(refused).toMatchObject({
        status: 409,
        json: { error: "action_not_allowed", code: "signature_not_completed" },
    });
    expect((await action("reissue_packet")).json.code).toBe(
        "packet_not_reissuable"
    );
    expect(
        (await action("confirm_provisioning", { kelevo_ref: "K1" })).json.code
    ).toBe("provisioning_not_manual");
    const audit = await prisma.onboardingEvent.findMany({
        where: { type: "audit.action.resend_payment_link" },
    });
    expect(audit[0].payload.outcome).toBe("refused:signature_not_completed");
});

it("reissue_packet action after a decline sends a new envelope", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const [envelope] = await prisma.signatureEnvelope.findMany();
    signature.decline(envelope.provider_document_id);
    await reconcileOnce(deps);
    expect((await request()).signature_state).toBe("DECLINED");
    const reissued = await action("reissue_packet");
    expect(reissued.json.signature.state).toBe("SENT");
    expect(await prisma.signatureEnvelope.count()).toBe(2);
});

it("cancel closes the request, withdraws the open packet and blocks further actions", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const cancelled = await action("cancel", {
        reason: "carrier changed their mind",
    });
    expect(cancelled.json).toMatchObject({
        readiness: "CLOSED",
        blocked: null,
    });
    expect(signature.documents.size).toBe(0);
    expect((await action("cancel")).status).toBe(409);
    expect((await action("verify_operation_item", { key: "W9" })).status).toBe(
        409
    );
});

it("signed document download is authenticated, needs an actor and is logged", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    expect(
        (
            await app.call(
                "GET",
                `/requests/${KEY}/documents/signed`,
                undefined,
                {
                    headers: {
                        "X-IW-Actor-Id": ACTOR.user_id,
                        "X-IW-Actor-Email": ACTOR.email,
                    },
                }
            )
        ).status
    ).toBe(404);
    const [envelope] = await prisma.signatureEnvelope.findMany();
    signature.complete(envelope.provider_document_id);
    await reconcileOnce(deps);
    expect(
        (
            await app.call(
                "GET",
                `/requests/${KEY}/documents/signed`,
                undefined,
                { auth: false }
            )
        ).status
    ).toBe(401);
    expect(
        (await app.call("GET", `/requests/${KEY}/documents/signed`)).status
    ).toBe(422);
    const ok = await app.call(
        "GET",
        `/requests/${KEY}/documents/signed`,
        undefined,
        {
            headers: {
                "X-IW-Actor-Id": ACTOR.user_id,
                "X-IW-Actor-Email": ACTOR.email,
            },
        }
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toMatch(/application\/pdf/);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.text.startsWith("%PDF-")).toBe(true);
    // The R15 completion email's attachment is logged as its own disclosure.
    const downloads = {
        where: { document: { startsWith: "signed_packet:" } },
        orderBy: { at: "asc" },
    };
    expect(
        await prisma.documentAccessLog.count({
            where: { document: { startsWith: "signed_packet_email:" } },
        })
    ).toBe(1);
    let logs = await prisma.documentAccessLog.findMany(downloads);
    expect(logs).toHaveLength(1);
    expect(logs[0].actor).toEqual(ACTOR);
    // The log records the signed actor (canonical lower-case email).
    await app.call("GET", `/requests/${KEY}/documents/signed`, undefined, {
        headers: {
            "X-IW-Actor-Id": ACTOR.user_id,
            "X-IW-Actor-Email": ACTOR.email.toUpperCase(),
        },
    });
    logs = await prisma.documentAccessLog.findMany(downloads);
    expect(logs).toHaveLength(2);
    expect(logs[1].actor).toEqual(ACTOR);
});

it("outbox delivers signed status events with backoff and stops on permanent errors", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const seen = [];
    let reply = 503;
    const fetch = jest.fn(async (url, init) => {
        seen.push({ url, init });
        return { status: reply };
    });
    expect(await deliverPending(deps, { fetch })).toEqual({
        delivered: 0,
        failed: 3,
    });
    const retrying = await prisma.onboardingEvent.findMany({
        where: { type: "onboarding.status.v1" },
    });
    expect(
        retrying.every(
            (e) => e.attempts === 1 && e.next_attempt_at > new Date()
        )
    ).toBe(true);
    // Nothing is due yet.
    expect(await deliverPending(deps, { fetch })).toEqual({
        delivered: 0,
        failed: 0,
    });
    await prisma.onboardingEvent.updateMany({
        data: { next_attempt_at: new Date(Date.now() - 1000) },
    });
    reply = 200;
    expect(await deliverPending(deps, { fetch })).toEqual({
        delivered: 3,
        failed: 0,
    });
    const call = seen.at(-1);
    expect(call.url).toBe(OUTBOX.url);
    expect(call.init.headers.Authorization).toBe(`Bearer ${OUTBOX.token}`);
    expect(
        verifySignature({
            secret: OUTBOX.signingSecret,
            header: call.init.headers["X-IW-Signature"],
            rawBody: call.init.body,
            nowSeconds: Math.floor(Date.now() / 1000),
        })
    ).toBeNull();
    expect(onboardingStatusV1.parse(JSON.parse(call.init.body)).contract).toBe(
        "onboarding.status.v1"
    );
    // A permanent rejection is not retried.
    await action("verify_operation_item", { key: "W9" });
    reply = 422;
    await deliverPending(deps, { fetch });
    const dead = await prisma.onboardingEvent.findFirst({
        where: { type: "onboarding.status.v1", delivered_at: null },
    });
    expect(dead).toMatchObject({
        next_attempt_at: null,
        last_error_code: "http_422",
    });
    // Disabled module or unconfigured outbox sends nothing.
    expect(
        await deliverPending(
            { ...deps, config: { ...config, outbox: { enabled: false } } },
            { fetch }
        )
    ).toEqual({
        delivered: 0,
        failed: 0,
    });
});

it("outbox signs each delivery with its own timestamp and never follows redirects", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    let clock = Date.now();
    deps.now = () => new Date((clock += 7000));
    const seen = [];
    const fetch = jest.fn(async (url, init) => {
        seen.push(init);
        return { status: 200 };
    });
    expect((await deliverPending(deps, { fetch })).delivered).toBe(3);
    const stamps = seen.map((init) =>
        Number(/^t=(\d+),/.exec(init.headers["X-IW-Signature"])[1])
    );
    expect(new Set(stamps).size).toBe(3);
    expect(stamps[2] - stamps[0]).toBeGreaterThanOrEqual(14);
    expect(seen.every((init) => init.redirect === "manual")).toBe(true);
});

it("outbox retries 3xx normally and 401/403/404 with a long, capped backoff", async () => {
    const { MAX_ATTEMPTS, slowBackoffMs } = await import(
        "../../src/onboarding/outbox"
    );
    expect(slowBackoffMs(1)).toBe(15 * 60000);
    expect(slowBackoffMs(2)).toBe(30 * 60000);
    expect(slowBackoffMs(30)).toBe(6 * 3600000);
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    await prisma.onboardingEvent.deleteMany({
        where: { type: "onboarding.status.v1", version: { gt: 1 } },
    });
    const due = () =>
        prisma.onboardingEvent.updateMany({
            where: { delivered_at: null },
            data: { next_attempt_at: new Date(Date.now() - 1000) },
        });
    const event = () =>
        prisma.onboardingEvent.findFirst({
            where: { type: "onboarding.status.v1" },
        });
    let reply = 302;
    const fetch = async () => ({ status: reply });
    await deliverPending(deps, { fetch });
    let row = await event();
    expect(row.last_error_code).toBe("http_302");
    expect(row.next_attempt_at.getTime() - Date.now()).toBeLessThan(60000);
    for (const status of [401, 403, 404]) {
        reply = status;
        await due();
        const before = Date.now();
        await deliverPending(deps, { fetch });
        row = await event();
        expect(row.last_error_code).toBe(`http_${status}`);
        expect(row.next_attempt_at).not.toBeNull();
        expect(row.next_attempt_at.getTime() - before).toBeGreaterThanOrEqual(
            15 * 60000
        );
    }
    // Still bounded by MAX_ATTEMPTS.
    await prisma.onboardingEvent.updateMany({
        where: { delivered_at: null },
        data: { attempts: MAX_ATTEMPTS - 1 },
    });
    await due();
    await deliverPending(deps, { fetch });
    expect((await event()).next_attempt_at).toBeNull();
});

it("workers start only when enabled and switched on", () => {
    expect(startOnboardingWorkers({ config: { enabled: false } })).toBeNull();
    const none = startOnboardingWorkers({
        ...deps,
        config: { ...config, outbox: { enabled: false } },
    });
    // Only the daily retention pass, which runs whenever onboarding is on.
    expect(none.count).toBe(1);
    none.stop();
    const both = startOnboardingWorkers({
        ...deps,
        config: { ...config, reconcile: { enabled: true, intervalMs: 900000 } },
    });
    expect(both.count).toBe(3);
    both.stop();
});

it("keeps secrets out of logs, events and responses", async () => {
    signature.failNext("send", "timeout");
    await toPaymentReady().catch(() => null);
    await reconcileOnce(deps);
    const haystack = JSON.stringify([
        deps.logger.lines,
        await prisma.onboardingEvent.findMany(),
        (await app.call("GET", `/requests/${KEY}`)).json,
    ]);
    for (const secret of [
        TOKEN,
        SIGNING,
        config.continueSecret,
        config.stripe.secretKey,
        config.stripe.webhookSecret,
        config.signature.webhookId,
        OUTBOX.token,
        OUTBOX.signingSecret,
        config.documents.key.toString("base64"),
    ])
        expect(haystack).not.toContain(secret);
});
