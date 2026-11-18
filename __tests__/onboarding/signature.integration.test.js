import { prisma } from "../../src/prismaClient";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import { signSignwellEvent } from "../../src/onboarding/signature/signwell";
import {
    reconcileSignature,
    openEnvelopeIds,
    reconcileEnvelope,
} from "../../src/onboarding/signatureFlow";
import {
    BUNDLE,
    WEBHOOK_ID,
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

serializeSuite();

const KEY = fixture("onboarding.request.v1").idempotency_key;
let app, deps, config, queue, signature;

beforeEach(async () => {
    await cleanTables(prisma);
    const dir = tempDir();
    config = testConfig(dir);
    queue = taskQueue();
    signature = createFakeSignatureProvider();
    deps = createOnboardingDeps(config, {
        db: prisma,
        logger: captureLogger(),
        sendEmail: jest.fn(),
        signature,
        schedule: queue.schedule,
        onSignatureCompleted: jest.fn(),
    });
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

const put = async () => {
    const response = await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    return response;
};
const request = () =>
    prisma.onboardingRequest.findUnique({ where: { idempotency_key: KEY } });
const envelopes = async () =>
    prisma.signatureEnvelope.findMany({
        where: { request: { idempotency_key: KEY } },
        orderBy: { created_at: "asc" },
    });
const nowS = () => Math.floor(Date.now() / 1000);
// Webhook re-fetches are throttled per envelope; tests that need several
// re-fetches clear the throttle explicitly.
const unthrottle = () =>
    prisma.signatureEnvelope.updateMany({
        data: { last_webhook_fetch_at: null },
    });
const webhook = (type, documentId, time = nowS()) =>
    app.call(
        "POST",
        "/webhooks/signwell",
        {
            event: {
                type,
                time,
                hash: signSignwellEvent(type, time, WEBHOOK_ID),
            },
            data: { object: { id: documentId, status: "ignored-hint" } },
        },
        { auth: false }
    );

it("sends the filled packet once after the PUT: draft, then send, with both signers", async () => {
    await put();
    expect((await request()).signature_state).toBe("SENT");
    const [envelope] = await envelopes();
    expect(envelope).toMatchObject({ state: "SENT", provider: "fake" });
    expect(envelope.filled_sha256).toMatch(/^[0-9a-f]{64}$/);
    const doc = signature.documents.get(envelope.provider_document_id);
    expect(doc.signers.map((s) => [s.id, s.role, s.email])).toEqual([
        ["1", "Carrier", "owner@example.test"],
        ["2", "Dispatch", "dispatch@example.test"],
    ]);
    expect(doc.metadata).toMatchObject({
        onboarding_request_id: envelope.request_id,
        envelope_id: envelope.id,
    });
    expect(doc.metadata.redirect_url).toMatch(
        /^https:\/\/api\.example\.test\/onboarding\/continue\//
    );
    // Repeated deliveries never send a second packet.
    await put();
    await put();
    expect(signature.calls.createEnvelope).toBe(1);
    expect(signature.calls.send).toBe(1);
    const versions = (
        await prisma.onboardingEvent.findMany({
            where: { type: "onboarding.status.v1" },
        })
    ).map((e) => e.version);
    expect(versions.sort()).toEqual([1, 2, 3]);
});

it("completes only after re-fetching: stores the completed PDF encrypted with its sha256", async () => {
    await put();
    const [envelope] = await envelopes();
    // A hint for a document that is not completed changes nothing.
    expect(
        (await webhook("document_completed", envelope.provider_document_id))
            .status
    ).toBe(200);
    expect((await request()).signature_state).toBe("SENT");
    signature.complete(envelope.provider_document_id);
    await unthrottle();
    expect(
        (await webhook("document_signed", envelope.provider_document_id)).status
    ).toBe(200);
    await queue.drain();
    const done = (await envelopes())[0];
    expect(done.state).toBe("COMPLETED");
    expect(done.completed_sha256).toMatch(/^[0-9a-f]{64}$/);
    const pdf = await deps.documentStore.get(done.completed_storage_key, {
        expectedSha256: done.completed_sha256,
    });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await request()).signature_state).toBe("COMPLETED");
    expect(deps.onSignatureCompleted).toHaveBeenCalledTimes(1);
    const status = await app.call("GET", `/requests/${KEY}`);
    expect(status.json.documents.signed_available).toBe(true);
});

it("rejects a forged webhook and ignores a replayed one", async () => {
    await put();
    const [envelope] = await envelopes();
    const forged = await app.call(
        "POST",
        "/webhooks/signwell",
        {
            event: {
                type: "document_completed",
                time: nowS(),
                hash: "0".repeat(64),
            },
            data: { object: { id: envelope.provider_document_id } },
        },
        { auth: false }
    );
    expect(forged.status).toBe(401);
    signature.complete(envelope.provider_document_id);
    const time = nowS();
    expect(
        (
            await webhook(
                "document_completed",
                envelope.provider_document_id,
                time
            )
        ).status
    ).toBe(200);
    const gets = signature.calls.get;
    await unthrottle();
    // Same signed tuple again: dropped (the envelope is closed now as well).
    expect([200, 202]).toContain(
        (
            await webhook(
                "document_completed",
                envelope.provider_document_id,
                time
            )
        ).status
    );
    expect(signature.calls.get).toBe(gets);
    expect(signature.calls.downloadCompleted).toBe(1);
    expect(
        await prisma.providerWebhookReceipt.count({
            where: { provider: "signwell" },
        })
    ).toBe(1);
});

it("bounds replays: stale events, unknown or closed ids and bursts never reach the provider", async () => {
    await put();
    const [envelope] = await envelopes();
    const gets = () => signature.calls.get;
    const before = gets();
    // Captured event replayed later (or from the future): ignored.
    expect(
        (
            await webhook(
                "document_completed",
                envelope.provider_document_id,
                nowS() - 601
            )
        ).status
    ).toBe(202);
    expect(
        (
            await webhook(
                "document_completed",
                envelope.provider_document_id,
                nowS() + 601
            )
        ).status
    ).toBe(202);
    expect(deps.logger.lines.some((l) => l.code === "stale_event")).toBe(true);
    // A valid tuple with an id we did not create: no provider fetch.
    expect(
        (await webhook("document_completed", "someone_elses_document")).status
    ).toBe(202);
    expect(gets()).toBe(before);
    // Distinct documents sharing one second both process (different ids in the key).
    const time = nowS();
    expect(
        (await webhook("document_viewed", envelope.provider_document_id, time))
            .status
    ).toBe(200);
    expect(gets()).toBe(before + 1);
    // Burst: a different event within 30 s is throttled.
    expect(
        (await webhook("document_signed", envelope.provider_document_id, time))
            .status
    ).toBe(202);
    expect(gets()).toBe(before + 1);
    // A closed envelope is never fetched by a webhook.
    signature.decline(envelope.provider_document_id);
    await reconcileEnvelope(deps, envelope.id);
    const afterDecline = gets();
    await unthrottle();
    expect(
        (await webhook("document_declined", envelope.provider_document_id))
            .status
    ).toBe(202);
    expect(gets()).toBe(afterDecline);
});

it("recovers a lost webhook through the reconcile poll", async () => {
    await put();
    const [envelope] = await envelopes();
    signature.complete(envelope.provider_document_id);
    expect(await openEnvelopeIds(prisma, Date.now())).toEqual([envelope.id]);
    for (const id of await openEnvelopeIds(prisma, Date.now()))
        await reconcileEnvelope(deps, id);
    expect((await request()).signature_state).toBe("COMPLETED");
    expect(await openEnvelopeIds(prisma, Date.now())).toEqual([]);
});

it("send timeout after acceptance → UNKNOWN → reconcile without a second document", async () => {
    signature.failNext("send", "timeout_after");
    await put();
    let row = await request();
    expect(row.signature_state).toBe("UNKNOWN");
    expect((await app.call("GET", `/requests/${KEY}`)).json).toMatchObject({
        readiness: "BLOCKED",
        blocked: { code: "send_outcome_unknown", action: "reconcile" },
    });
    await reconcileSignature(deps, row.id);
    row = await request();
    expect(row.signature_state).toBe("SENT");
    expect(signature.calls.createEnvelope).toBe(1);
    expect(signature.documents.size).toBe(1);
    expect([...signature.documents.values()][0].sends).toBe(1);
});

it("send timeout before acceptance → UNKNOWN → reconcile sends the same draft", async () => {
    signature.failNext("send", "timeout");
    await put();
    const row = await request();
    expect(row.signature_state).toBe("UNKNOWN");
    await reconcileSignature(deps, row.id);
    expect((await request()).signature_state).toBe("SENT");
    expect(signature.calls.createEnvelope).toBe(1);
    expect([...signature.documents.values()][0].sends).toBe(1);
});

it("create timeout → NOT_SENT blocked; an orphan draft's webhook is ignored unfetched; reconcile retries", async () => {
    signature.failNext("createEnvelope", "timeout_after");
    await put();
    const row = await request();
    expect(row).toMatchObject({
        signature_state: "NOT_SENT",
        signature_code: "packet_create_failed",
    });
    const [orphanId] = [...signature.documents.keys()];
    const gets = signature.calls.get;
    expect((await webhook("document_created", orphanId)).status).toBe(202);
    expect(signature.calls.get).toBe(gets);
    // The orphan is a draft: it cannot email anyone. It stays for manual cleanup.
    expect(signature.documents.get(orphanId).status).toBe("draft");
    await reconcileSignature(deps, row.id);
    expect((await request()).signature_state).toBe("SENT");
    expect(signature.documents.size).toBe(2);
    expect(signature.calls.send).toBe(1);
});

it("declined → CLOSED; reissue supersedes it with a new envelope; expired works the same", async () => {
    await put();
    const [first] = await envelopes();
    signature.decline(first.provider_document_id);
    await webhook("document_declined", first.provider_document_id);
    expect((await app.call("GET", `/requests/${KEY}`)).json).toMatchObject({
        readiness: "CLOSED",
        signature: { state: "DECLINED" },
        blocked: { action: "reissue_packet" },
    });
    const { reissuePacket } = await import(
        "../../src/onboarding/signatureFlow"
    );
    await reissuePacket(deps, first.request_id);
    let list = await envelopes();
    expect(list).toHaveLength(2);
    expect(list[0].superseded_by).toBe(list[1].id);
    expect(list[1].state).toBe("SENT");
    expect((await request()).signature_state).toBe("SENT");
    // A second reissue while the new envelope is open is refused.
    expect(await reissuePacket(deps, first.request_id)).toBeNull();
    signature.expire(list[1].provider_document_id);
    await reconcileEnvelope(deps, list[1].id);
    expect((await request()).signature_state).toBe("EXPIRED");
    // Late events for the superseded envelope do not touch the request.
    await unthrottle();
    expect(
        (await webhook("document_declined", first.provider_document_id)).status
    ).toBe(202);
    expect((await request()).signature_state).toBe("EXPIRED");
    await reissuePacket(deps, first.request_id);
    list = await envelopes();
    expect(list).toHaveLength(3);
});

it("without an approved bundle the request is blocked, not sent", async () => {
    await deleteBundles(prisma, BUNDLE);
    await put();
    expect(await request()).toMatchObject({
        signature_state: "NOT_SENT",
        signature_code: "bundle_unavailable",
    });
    expect(signature.calls.createEnvelope).toBe(0);
});
