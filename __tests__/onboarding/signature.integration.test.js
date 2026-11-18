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

it("rejects non-canonical hashes and times; replays of one signed tuple are duplicates", async () => {
    await put();
    const [envelope] = await envelopes();
    const time = nowS();
    const hash = signSignwellEvent("document_viewed", time, WEBHOOK_ID);
    const post = (event) =>
        app.call(
            "POST",
            "/webhooks/signwell",
            { event, data: { object: { id: envelope.provider_document_id } } },
            { auth: false }
        );
    expect(
        (
            await post({
                type: "document_viewed",
                time,
                hash: hash.toUpperCase(),
            })
        ).status
    ).toBe(401);
    expect(
        (await post({ type: "document_viewed", time: time + 0.5, hash })).status
    ).toBe(401);
    expect(
        (await post({ type: "document_viewed", time: `${time}.0`, hash }))
            .status
    ).toBe(401);
    expect((await post({ type: "document_viewed", time, hash })).status).toBe(
        200
    );
    await unthrottle();
    const gets = signature.calls.get;
    // Same tuple again, also with the time as a digit string: duplicate.
    expect(
        (await post({ type: "document_viewed", time: String(time), hash }))
            .status
    ).toBe(200);
    expect(signature.calls.get).toBe(gets);
    const receipts = await prisma.providerWebhookReceipt.findMany({
        where: { provider: "signwell" },
    });
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receipt_key).toBe(
        `signwell:document_viewed:${time}:${hash}:${envelope.provider_document_id}`
    );
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

it("a send refused as not ready (422) right after upload is retried on the same document", async () => {
    deps.sleep = jest.fn(async () => {});
    signature.failNext("send", "reject");
    await put();
    expect((await request()).signature_state).toBe("SENT");
    expect(deps.sleep).toHaveBeenCalledTimes(1);
    expect(signature.calls.createEnvelope).toBe(1);
    expect([...signature.documents.values()][0].sends).toBe(1);
});

it("a send still refused after the retries is ERROR, and a verified re-fetch showing it sent recovers it", async () => {
    deps.sleep = jest.fn(async () => {});
    for (let i = 0; i < 4; i += 1) signature.failNext("send", "reject");
    await put();
    let row = await request();
    expect(row.signature_state).toBe("ERROR");
    expect(deps.sleep).toHaveBeenCalledTimes(3);
    // The provider later shows the document as sent (e.g. an operator or a
    // delayed send at the provider): reconcile must follow the re-fetch.
    const [doc] = [...signature.documents.values()];
    doc.status = "sent";
    await reconcileSignature(deps, row.id);
    row = await request();
    expect(row.signature_state).toBe("SENT");
    expect(signature.calls.createEnvelope).toBe(1);
    expect(signature.documents.size).toBe(1);
});

it("a 422 because a concurrent send already went through is success, never ERROR", async () => {
    deps.sleep = jest.fn(async () => {});
    await put();
    let row = await request();
    expect(row.signature_state).toBe("SENT");
    // Force a second send of the same, already-sent document (as a concurrent
    // reconcile would): the fake answers 422 because it is not a draft.
    await prisma.signatureEnvelope.updateMany({ data: { state: "UNKNOWN" } });
    await prisma.onboardingRequest.updateMany({
        data: { signature_state: "UNKNOWN" },
    });
    const [doc] = [...signature.documents.values()];
    doc.status = "draft"; // reconcile sees a draft and re-sends …
    signature.failNext("send", "reject"); // … but the provider says 422
    const realGet = signature.get.bind(signature);
    signature.get = async (id) => {
        const remote = await realGet(id);
        if (signature.calls.send >= 2) return { ...remote, status: "sent" };
        return remote;
    };
    await reconcileSignature(deps, row.id);
    row = await request();
    expect(row.signature_state).toBe("SENT");
    expect(deps.sleep).not.toHaveBeenCalled();
    expect(signature.calls.createEnvelope).toBe(1);
});

it("a failure write never downgrades an envelope confirmed SENT meanwhile", async () => {
    await put();
    const [envelope] = await envelopes();
    // Put the envelope back into an uncertain state with a draft remotely, so
    // reconcile re-sends; every send attempt is refused while it stays a draft.
    await prisma.signatureEnvelope.update({
        where: { id: envelope.id },
        data: { state: "UNKNOWN" },
    });
    signature.documents.get(envelope.provider_document_id).status = "draft";
    for (let i = 0; i < 4; i += 1) signature.failNext("send", "reject");
    // While the retries sleep, a concurrent path confirms the send.
    deps.sleep = jest.fn(async () => {
        await prisma.signatureEnvelope.update({
            where: { id: envelope.id },
            data: { state: "SENT" },
        });
    });
    await reconcileEnvelope(deps, envelope.id);
    expect(deps.sleep).toHaveBeenCalled();
    const [after] = await envelopes();
    expect(after.state).toBe("SENT");
    expect(after.last_error_code).toBeNull();
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

describe("cancel vs an in-flight send", () => {
    const cancelRow = () =>
        prisma.onboardingRequest.update({
            where: { idempotency_key: KEY },
            data: { cancelled_at: new Date() },
        });

    it("cancelled before the draft is created: nothing is created or sent", async () => {
        const put = deps.documentStore.put.bind(deps.documentStore);
        let first = true;
        deps.documentStore.put = async (bytes) => {
            if (first) {
                first = false;
                await cancelRow();
            }
            return put(bytes);
        };
        await app.call("PUT", `/requests/${KEY}`, requestBody());
        await queue.drain();
        expect(signature.calls.createEnvelope).toBe(0);
        expect(signature.calls.send).toBe(0);
        const [envelope] = await envelopes();
        expect(envelope.state).toBe("CANCELLED");
    });

    it("cancelled after the draft was created: never sent, the draft is deleted", async () => {
        const create = signature.createEnvelope.bind(signature);
        signature.createEnvelope = async (...args) => {
            const created = await create(...args);
            await cancelRow();
            return created;
        };
        await app.call("PUT", `/requests/${KEY}`, requestBody());
        await queue.drain();
        expect(signature.calls.send).toBe(0);
        expect(signature.calls.delete).toBe(1);
        expect(signature.documents.size).toBe(0);
        const [envelope] = await envelopes();
        expect(envelope.state).toBe("CANCELLED");
        // A later reconcile never sends it either.
        await reconcileEnvelope(deps, envelope.id);
        expect(signature.calls.send).toBe(0);
    });
});

it("reissue from ERROR withdraws the old provider document first", async () => {
    await put();
    const [old] = await envelopes();
    await prisma.signatureEnvelope.update({
        where: { id: old.id },
        data: { state: "ERROR" },
    });
    await prisma.onboardingRequest.update({
        where: { idempotency_key: KEY },
        data: { signature_state: "ERROR", signature_code: "send_rejected" },
    });
    const { reissuePacket } = await import(
        "../../src/onboarding/signatureFlow"
    );
    await reissuePacket(deps, old.request_id);
    expect(signature.documents.has(old.provider_document_id)).toBe(false);
    const [superseded, fresh] = await envelopes();
    expect(superseded).toMatchObject({ id: old.id, state: "CANCELLED" });
    expect(fresh.state).toBe("SENT");
    expect(signature.documents.size).toBe(1);
});

it("reissue from ERROR logs a failed withdrawal by code and still reissues", async () => {
    await put();
    const [old] = await envelopes();
    await prisma.signatureEnvelope.update({
        where: { id: old.id },
        data: { state: "ERROR" },
    });
    signature.failNext("delete", "reject");
    const { reissuePacket } = await import(
        "../../src/onboarding/signatureFlow"
    );
    await reissuePacket(deps, old.request_id);
    expect(
        deps.logger.lines.some(
            (l) => l.code === "onboarding_reissue_withdraw_failed"
        )
    ).toBe(true);
    expect((await envelopes())[1].state).toBe("SENT");
});

it("a throttled SignWell event keeps its receipt: its redelivery is processed", async () => {
    await put();
    const [envelope] = await envelopes();
    const time = nowS();
    expect(
        (await webhook("document_viewed", envelope.provider_document_id, time))
            .status
    ).toBe(200);
    const before = signature.calls.get;
    // Inside the 30 s window: throttled, no fetch.
    expect(
        (await webhook("document_signed", envelope.provider_document_id, time))
            .status
    ).toBe(202);
    expect(signature.calls.get).toBe(before);
    // Window over: SignWell redelivers the same event; it must be fetched.
    await unthrottle();
    expect(
        (await webhook("document_signed", envelope.provider_document_id, time))
            .status
    ).toBe(200);
    expect(signature.calls.get).toBe(before + 1);
    // A true duplicate is still deduplicated without a fetch.
    await unthrottle();
    expect(
        (await webhook("document_signed", envelope.provider_document_id, time))
            .status
    ).toBe(200);
    expect(signature.calls.get).toBe(before + 1);
});

it("a successful send never downgrades an envelope a concurrent reconcile saw VIEWED", async () => {
    const send = signature.send.bind(signature);
    signature.send = async (id) => {
        const result = await send(id);
        await prisma.signatureEnvelope.updateMany({
            where: { provider_document_id: id },
            data: { state: "VIEWED" },
        });
        return result;
    };
    await put();
    const [envelope] = await envelopes();
    expect(envelope.state).toBe("VIEWED");
});

describe("completed PDF audit page", () => {
    it("outside test mode, a completed PDF without the audit page is not COMPLETED", async () => {
        await put();
        const [envelope] = await envelopes();
        signature.complete(envelope.provider_document_id);
        signature.omitAuditPage(envelope.provider_document_id);
        await reconcileEnvelope(deps, envelope.id);
        const open = (await envelopes())[0];
        expect(open).toMatchObject({
            state: "SENT",
            last_error_code: "audit_page_missing",
            completed_storage_key: null,
        });
        expect(await request()).toMatchObject({
            signature_state: "SENT",
            signature_code: "audit_page_missing",
        });
        expect(deps.onSignatureCompleted).not.toHaveBeenCalled();
        expect(
            deps.logger.lines.some(
                (l) => l.code === "onboarding_audit_page_missing"
            )
        ).toBe(true);
        const status = (await app.call("GET", `/requests/${KEY}`)).json;
        expect(status).toMatchObject({
            readiness: "BLOCKED",
            blocked: { code: "audit_page_missing", action: "reconcile" },
            documents: { signed_available: false },
        });
        // Still polled; once the provider serves the audit page it completes.
        expect(await openEnvelopeIds(prisma, Date.now())).toContain(
            envelope.id
        );
        signature.documents.get(envelope.provider_document_id).omitAuditPage =
            false;
        await reconcileEnvelope(deps, envelope.id);
        expect(await request()).toMatchObject({
            signature_state: "COMPLETED",
            signature_code: null,
        });
    });

    it("with the audit page, the completed PDF has more pages than the packet", async () => {
        await put();
        const [envelope] = await envelopes();
        signature.complete(envelope.provider_document_id);
        await reconcileEnvelope(deps, envelope.id);
        expect((await request()).signature_state).toBe("COMPLETED");
    });

    it("in SignWell test mode the check is skipped", async () => {
        config.signature.testMode = true;
        await put();
        const [envelope] = await envelopes();
        signature.complete(envelope.provider_document_id);
        signature.omitAuditPage(envelope.provider_document_id);
        await reconcileEnvelope(deps, envelope.id);
        expect((await request()).signature_state).toBe("COMPLETED");
    });
});

it("the packet carries the requester name and per-recipient copy without braces", async () => {
    await put();
    const [document] = [...signature.documents.values()];
    expect(document.metadata).toMatchObject({
        name: "Iron Wing dispatch agreement — Example Freight LLC",
        requester_name: "Iron Wing Logistics L.L.C.",
        requester_email: null,
    });
    const [carrier, dispatch] = document.signers;
    expect(carrier.subject).toMatch(/^Iron Wing: your dispatch agreement for /);
    expect(dispatch.subject).toMatch(/^INTERNAL — countersign: /);
    const [envelope] = await envelopes();
    const request = await prisma.onboardingRequest.findUnique({
        where: { id: envelope.request_id },
    });
    expect(dispatch.message).toContain(request.id.slice(0, 8));
    expect(dispatch.message).not.toContain(request.id);
    expect(dispatch.message).not.toContain(envelope.provider_document_id);
    for (const text of [
        document.metadata.name,
        carrier.subject,
        carrier.message,
        dispatch.subject,
        dispatch.message,
    ])
        expect(text).not.toMatch(/[{}]/);
});
