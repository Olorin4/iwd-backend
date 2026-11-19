import express from "express";
import http from "node:http";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prismaClient.js";
import {
    MAX_UPLOAD_BYTES,
    PORTAL_BASE_URL,
} from "../../src/onboarding/config.js";
import { createOnboardingDeps } from "../../src/onboarding/deps.js";
import {
    createOnboardingRouter,
    onboardingRawBody,
} from "../../src/onboarding/routes.js";
import { putRequest } from "../../src/onboarding/requests.js";
import { createPortalRouter } from "../../src/onboarding/portal/routes.js";
import {
    issuePortalToken,
    activePortalUrl,
    resolvePortalToken,
} from "../../src/onboarding/portal/tokens.js";
import { csrfToken } from "../../src/onboarding/portal/csrf.js";
import {
    recordUpload,
    listDocuments,
} from "../../src/onboarding/files/documents.js";
import { createR2DocumentStore } from "../../src/onboarding/files/r2Store.js";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake.js";
import { runAction } from "../../src/onboarding/actions.js";
import {
    applyFacetChange,
    lockRequest,
    currentStatus,
} from "../../src/onboarding/store.js";
import { readPendingDocuments } from "../../src/onboarding/reader/worker.js";
import {
    portalMissingSteps,
    sendDuePortalReminder,
    sendPortalInvitation,
} from "../../src/onboarding/portalFlow.js";
import { purgeDue } from "../../src/onboarding/retention.js";
import { saveQuestionnaire } from "../../src/onboarding/questionnaire.js";
import {
    verifyOperationItem,
    OPERATION_SLOTS,
    confirmLoadBoardAccess,
    deriveReadiness,
    facetsOf,
} from "../../src/onboarding/readiness.js";
import { onboardingStatusV1 } from "../../src/onboarding/contracts.js";
import {
    BUNDLE,
    approveTestBundle,
    captureLogger,
    cleanTables,
    deleteBundles,
    requestBody,
    serializeSuite,
    signedHeaders,
    taskQueue,
    tempDir,
    testConfig,
} from "./harness.js";
import { createFakeStripe } from "./fakeStripe.js";
import { makeSyntheticPacket, syntheticLayout } from "./pdfFixtures.js";

serializeSuite();

const PORTAL_HOST = new URL(PORTAL_BASE_URL).host;
const ACTOR = { user_id: "portal-test-staff", email: "closer@example.test" };
const DATE = new Date("2026-11-18T16:00:00Z");
const upload = { source: "CARRIER", actor: { type: "carrier" } };
const pdf = Buffer.from("%PDF-1.7\nSynthetic document");
const w9 = {
    document_type_matches: true,
    legal_name: "Example Freight LLC",
    business_name: null,
    entity_type: "LLC",
    tin_type: "EIN",
    tin_last4: "6789",
    address: "Never store 12-3456789",
    signature_present: true,
    signature_date: null,
};

let deps,
    config,
    db,
    now,
    server,
    address,
    directory,
    queue,
    signature,
    stripe,
    sent,
    objects;

beforeEach(async () => {
    db = prisma;
    await cleanTables(db);
    directory = tempDir();
    config = testConfig(directory, {
        portal: {
            enabled: true,
            baseUrl: PORTAL_BASE_URL,
            tokenSecret: "p".repeat(40),
            linkGraceDays: 30,
        },
        files: { maxBytes: MAX_UPLOAD_BYTES },
        reader: { enabled: true },
        retention: { abandonedDays: 90, completedYears: 3 },
    });
    now = new Date(DATE);
    queue = taskQueue();
    signature = createFakeSignatureProvider();
    stripe = createFakeStripe();
    sent = jest.fn().mockResolvedValue({});
    objects = new Map();
    const fileStore = createR2DocumentStore({
        bucket: "test",
        key: Buffer.alloc(32, 3),
        client: {
            async send(command) {
                const { Key, Body } = command.input;
                if (command.constructor.name === "PutObjectCommand")
                    objects.set(Key, Body);
                else if (command.constructor.name === "GetObjectCommand")
                    return {
                        Body: {
                            transformToByteArray: async () => objects.get(Key),
                        },
                    };
                else if (command.constructor.name === "DeleteObjectCommand")
                    objects.delete(Key);
                else throw new Error("Unexpected fake R2 operation");
            },
        },
    });
    deps = createOnboardingDeps(config, {
        db,
        signature,
        stripe,
        fileStore,
        now: () => now,
        sendEmail: sent,
        logger: captureLogger(),
        schedule: queue.schedule,
        extractDocument: jest.fn().mockResolvedValue(w9),
    });
    const app = express();
    app.use(
        createPortalRouter(
            () => config,
            () => deps
        )
    );
    app.use(
        "/onboarding",
        express.json({ verify: onboardingRawBody }),
        createOnboardingRouter(
            () => config,
            () => deps
        )
    );
    server = await new Promise((resolve) => {
        const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    address = "http://127.0.0.1:" + server.address().port;
});

afterEach(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    await cleanTables(db);
    await deleteBundles(db, BUNDLE);
    await fs.rm(directory, { recursive: true, force: true });
});

async function createRequest(changes = {}, terms = {}) {
    const key = randomUUID();
    const result = await putRequest(
        deps,
        key,
        requestBody({ idempotency_key: key }, terms)
    );
    return db.onboardingRequest.update({
        where: { id: result.row.id },
        data: { portal_flow: true, signature_state: "COMPLETED", ...changes },
    });
}

const refreshed = (id) => db.onboardingRequest.findUnique({ where: { id } });
const eventCount = (id) =>
    db.onboardingEvent.count({
        where: { request_id: id, type: "onboarding.status.v1" },
    });
const act = (row, action, input = {}) =>
    runAction(deps, row.idempotency_key, action, { actor: ACTOR, ...input });
const pathname = (token) => new URL(token.url).pathname;

async function browser(
    path,
    { host = PORTAL_HOST, method = "GET", headers = {}, body } = {}
) {
    const url = address + path;
    if (body instanceof FormData) {
        const encoded = new Request(url, { method, body });
        headers = {
            ...headers,
            "Content-Type": encoded.headers.get("content-type"),
        };
        body = Buffer.from(await encoded.arrayBuffer());
    }
    return new Promise((resolve, reject) => {
        const request = http.request(
            url,
            {
                method,
                headers: {
                    Host: host,
                    ...headers,
                    ...(body
                        ? { "Content-Length": Buffer.byteLength(body) }
                        : {}),
                },
            },
            (response) => {
                const chunks = [];
                response.on("data", (chunk) => chunks.push(chunk));
                response.on("error", reject);
                response.on("end", () =>
                    resolve(
                        new Response(Buffer.concat(chunks), {
                            status: response.statusCode,
                            headers: response.headers,
                        })
                    )
                );
            }
        );
        request.on("error", reject);
        request.end(body);
    });
}

function staff(method, path, body, mediaType) {
    const raw = body ?? Buffer.alloc(0);
    const actor = {
        "X-IW-Actor-Id": ACTOR.user_id,
        "X-IW-Actor-Email": ACTOR.email,
    };
    return browser(path, {
        host: "api.example.test",
        method,
        headers: {
            ...signedHeaders({
                method,
                pathAndQuery: path,
                raw,
                t: Math.floor(now.getTime() / 1000),
                headers: actor,
            }),
            ...(mediaType ? { "Content-Type": mediaType } : {}),
        },
        body,
    });
}

function form(token, bytes, filename) {
    const data = new FormData();
    data.set("csrf", csrfToken(config.portal.tokenSecret, token.tokenId));
    data.set("file", new Blob([bytes], { type: "application/pdf" }), filename);
    return data;
}

test("portal doc versions serialize and staff can read and audit downloads", async () => {
    const row = await createRequest();
    const before = await eventCount(row.id);
    const results = await Promise.all([
        recordUpload(deps, row.id, "W9", pdf, upload),
        recordUpload(deps, row.id, "W9", pdf, upload),
    ]);
    expect(results.map(({ version }) => version).sort()).toEqual([1, 2]);
    expect(await eventCount(row.id)).toBe(before + 2);
    expect(
        (await refreshed(row.id)).operations.find((i) => i.key === "W9").state
    ).toBe("RECEIVED");
    const versions = await db.onboardingDocument.findMany({
        where: { request_id: row.id },
        orderBy: { version: "asc" },
    });
    expect(versions.map((document) => document.state)).toEqual([
        "SUPERSEDED",
        "CURRENT",
    ]);

    const endpoint =
        "/onboarding/requests/" + row.idempotency_key + "/documents";
    expect((await browser(endpoint, { host: "api.example.test" })).status).toBe(
        401
    );
    const list = await staff("GET", endpoint);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(await list.json()).toEqual(
        expect.objectContaining({
            documents: [
                expect.objectContaining({
                    id: versions[1].id,
                    state: "CURRENT",
                    version: 2,
                }),
            ],
            questionnaire: null,
            reupload_reasons: {},
        })
    );
    const file = await staff("GET", endpoint + "/" + versions[1].id + "/file");
    expect(file.status).toBe(200);
    expect(file.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(Buffer.from(await file.arrayBuffer())).toEqual(pdf);
    expect(
        await db.documentAccessLog.findFirst({ where: { request_id: row.id } })
    ).toMatchObject({
        actor: ACTOR,
        document: "upload:" + versions[1].id,
    });
    let response = await staff(
        "POST",
        endpoint + "/W9",
        pdf,
        "application/pdf"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "document_present" });
    await act(row, "verify_operation_item", {
        key: "W9",
        document_id: versions[1].id,
    });
    expect(await recordUpload(deps, row.id, "W9", pdf, upload)).toEqual({
        ok: false,
        code: "already_verified",
    });
    await act(row, "unverify_operation_item", { key: "W9" });
    const rejected = await act(row, "request_reupload", {
        key: "W9",
        reason: "Please attach the signed copy.",
    });
    expect(rejected.operations.items.find((i) => i.key === "W9")).toMatchObject(
        { state: "REUPLOAD_REQUESTED" }
    );
    expect(await listDocuments(db, row.id)).toEqual([
        expect.objectContaining({
            state: "REJECTED",
            reject_reason: "Please attach the signed copy.",
        }),
    ]);
    const detail = await staff("GET", endpoint);
    expect((await detail.json()).reupload_reasons).toEqual({
        W9: "Please attach the signed copy.",
    });
    expect(JSON.stringify(rejected)).not.toContain(
        "Please attach the signed copy."
    );
    response = await staff("POST", endpoint + "/W9", pdf, "application/pdf");
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ ok: true, version: 3 });
});

test("portal guards host and private link, checks Origin and CSRF, and rejects disguised uploads", async () => {
    const row = await createRequest(
        {},
        { legal_name: "Synthetic Freight LLC" }
    );
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const base = pathname(token);
    let response = await browser(base);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'"
    );
    const markup = await response.text();
    expect(markup).toMatch(/Synthetic Freight LLC/);
    for (const step of ["①", "②", "③", "④"]) expect(markup).toContain(step);
    expect((await refreshed(row.id)).portal_last_opened_at).toEqual(now);
    now = new Date(now.getTime() + 60 * 1000);
    await browser(base);
    expect((await refreshed(row.id)).portal_last_opened_at).toEqual(DATE);

    expect((await browser(base, { host: "api.example.test" })).status).toBe(
        404
    );
    expect(
        (await browser("/onboarding/requests/" + row.idempotency_key)).status
    ).toBe(404);
    response = await browser("/p/x");
    expect(response.status).toBe(410);
    expect(await response.text()).toContain(
        "onboarding@iron-wing-dispatching.com"
    );
    expect((await browser("/p/%FF")).status).toBe(410);
    expect(
        (await browser("/portal-static/portal.css")).headers.get(
            "cache-control"
        )
    ).toContain("immutable");

    const post = {
        method: "POST",
        body: "csrf=wrong",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
    };
    expect((await browser(base + "/not-factoring", post)).status).toBe(403);
    expect(
        (
            await browser(base + "/not-factoring", {
                ...post,
                headers: { ...post.headers, Origin: PORTAL_BASE_URL },
            })
        ).status
    ).toBe(403);
    response = await browser(base + "/documents/W9", {
        method: "POST",
        headers: { Origin: PORTAL_BASE_URL },
        body: form(
            token,
            Buffer.from("<html><script></script></html>"),
            "looks-like.pdf"
        ),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
        base + "?error=unsupported_type"
    );
    expect(objects.size).toBe(0);
    response = await browser(base + "/documents/W9", {
        method: "POST",
        headers: { Origin: PORTAL_BASE_URL },
        body: form(token, pdf, "synthetic.pdf"),
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(base + "?uploaded=W9");
    expect(objects.size).toBe(1);
    expect(JSON.stringify(deps.logger.lines)).not.toContain(base);
    await issuePortalToken(deps, row.id, { revokeExisting: true });
    expect((await browser(base)).status).toBe(410);
});

test("ready link grace is 30 days and purged requests never resolve", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id);
    const raw = pathname(token).slice(3);
    for (const [days, active] of [
        [29, true],
        [31, false],
    ]) {
        await db.onboardingRequest.update({
            where: { id: row.id },
            data: { ready_at: new Date(now.getTime() - days * 86400000) },
        });
        const result = await resolvePortalToken(deps, raw);
        expect(Boolean(result.row)).toBe(active);
    }
    await db.onboardingRequest.update({
        where: { id: row.id },
        data: { ready_at: now, purged_at: now },
    });
    expect(await resolvePortalToken(deps, raw)).toEqual({ error: "inactive" });
});

test("fake ordered signing sends one invitation, moves to Stripe and never sends the R15 completion email", async () => {
    const key = randomUUID();
    const { row } = await putRequest(
        deps,
        key,
        requestBody({ idempotency_key: key })
    );
    await approveTestBundle(db, deps.documentStore, {
        makePacket: makeSyntheticPacket,
        layout: syntheticLayout(),
    });
    await deps.onRequestCreated(row);
    const request = await refreshed(row.id);
    expect(request.portal_flow).toBe(true);
    const stored = await db.portalToken.findFirst({
        where: { request_id: row.id },
    });
    const { portalUrl } = await import("../../src/onboarding/portal/tokens.js");
    const base = new URL(portalUrl(config, stored.id)).pathname;
    const envelope = await db.signatureEnvelope.findFirst({
        where: { request_id: row.id },
    });
    expect(request.signature_waiting_for).toBe("IRON_WING");
    expect(
        signature.documents.get(envelope.provider_document_id).signers[1]
            .sendEmail
    ).toBe(false);
    let response = await browser(base + "/sign");
    expect(await response.text()).toContain(
        "Iron Wing is preparing your agreement."
    );
    expect(signature.calls.embeddedSigningUrl).toBe(0);
    expect((await browser(base + "/payment")).status).toBe(409);

    signature.sign(envelope.provider_document_id, "2");
    await deps.reconcileSignature(row.id);
    await queue.drain();
    await deps.reconcileSignature(row.id);
    await queue.drain();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0][0].text).toContain(PORTAL_BASE_URL + base);
    expect((await browser(base + "/sign")).status).toBe(303);
    signature.sign(envelope.provider_document_id, "1");
    // The carrier returns from SignWell before any webhook or reconcile ran:
    // /sign reconciles, and the first page already offers the download.
    response = await browser(base + "/sign");
    await queue.drain();
    expect(sent).toHaveBeenCalledTimes(1);
    const signed = await response.text();
    expect(signed).toContain("Signed ✓");
    expect(signed).toContain("Download signed agreement");
    expect(signed).not.toContain("Open agreement in SignWell");
    const download = await browser(base + "/agreement");
    expect(download.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(
        await db.documentAccessLog.findFirst({
            where: {
                request_id: row.id,
                document: { startsWith: "signed_packet:" },
            },
        })
    ).toMatchObject({ actor: { type: "carrier" } });
    await download.arrayBuffer();

    response = await browser(base + "/payment");
    expect(response.status).toBe(303);
    const session = [...stripe.sessions.values()][0];
    expect(session.input).toMatchObject({
        successUrl: PORTAL_BASE_URL + base + "?payment=saved",
        cancelUrl: PORTAL_BASE_URL + base + "?payment=cancelled",
    });

    expect(
        (await act(row, "resend_portal_link")).portal.invited_at
    ).toBeDefined();
    expect((await browser(base)).status).toBe(410);
    expect(sent).toHaveBeenCalledTimes(2);
});

test("reminders exclude carrier profile and a re-upload uses one of the two slots", async () => {
    const row = await createRequest();
    await issuePortalToken(deps, row.id);
    expect(await sendPortalInvitation(deps, row.id)).toBe(true);
    expect(portalMissingSteps(await refreshed(row.id))).not.toContain(
        "CARRIER_PROFILE"
    );
    await recordUpload(deps, row.id, "W9", pdf, upload);
    await act(row, "request_reupload", {
        key: "W9",
        reason: "Please upload the signed copy.",
    });
    expect(sent).toHaveBeenCalledTimes(2);
    now = new Date(now.getTime() + 14 * 86400000);
    expect(await sendDuePortalReminder(deps, row.id)).toBe(true);
    expect(sent.mock.calls[2][0].text).not.toMatch(/carrier profile/i);
    expect(await sendDuePortalReminder(deps, row.id)).toBe(false);
    expect(sent).toHaveBeenCalledTimes(3);
    const cancelled = await createRequest();
    await issuePortalToken(deps, cancelled.id);
    await sendPortalInvitation(deps, cancelled.id);
    await act(cancelled, "cancel");
    now = new Date(now.getTime() + 14 * 86400000);
    expect(await sendDuePortalReminder(deps, cancelled.id)).toBe(false);
});

test("reader saves safe extraction, fails after three invalid responses and never verifies", async () => {
    const row = await createRequest();
    const uploaded = await recordUpload(deps, row.id, "W9", pdf, upload);
    expect(await readPendingDocuments(deps)).toEqual({ done: 1, failed: 0 });
    expect(
        await db.onboardingDocument.findUnique({
            where: { id: uploaded.documentId },
        })
    ).toMatchObject({
        extraction_status: "DONE",
        extracted: { address: null, tin_last4: "6789" },
    });
    const status = await currentStatus(db, await refreshed(row.id));
    expect(
        onboardingStatusV1
            .parse(status)
            .operations.items.find((i) => i.key === "W9")
    ).toMatchObject({
        state: "RECEIVED",
        document: { version: 1, extraction: "DONE" },
    });
    const second = await recordUpload(deps, row.id, "W9", pdf, upload);
    deps.extractDocument.mockResolvedValue({ ...w9, tin_last4: "123456789" });
    for (let attempt = 1; attempt <= 3; attempt++)
        expect(await readPendingDocuments(deps)).toEqual({
            done: 0,
            failed: attempt === 3 ? 1 : 0,
        });
    expect(
        await db.onboardingDocument.findUnique({
            where: { id: second.documentId },
        })
    ).toMatchObject({
        extraction_status: "FAILED",
        extraction_attempts: 3,
        extracted: null,
    });
    expect(
        (await refreshed(row.id)).operations.find((i) => i.key === "W9").state
    ).toBe("RECEIVED");
});

test("retention purges abandoned documents after 90 days and keeps an audit record", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id);
    const uploadResult = await recordUpload(deps, row.id, "W9", pdf, upload);
    await readPendingDocuments(deps);
    await saveQuestionnaire(deps, row.id, {
        equipment_types: "Dry van",
        truck_count: 2,
    });
    const signed = await deps.documentStore.put(pdf);
    const filled = await deps.documentStore.put(pdf);
    const manifest = await deps.documentStore.put(
        Buffer.from(JSON.stringify({ files: [filled] }))
    );
    const env = await db.signatureEnvelope.create({
        data: {
            request_id: row.id,
            provider: "fake",
            state: "COMPLETED",
            completed_storage_key: signed.storage_key,
            completed_sha256: signed.sha256,
            filled_storage_key: manifest.storage_key,
            filled_sha256: manifest.sha256,
        },
    });
    await act(row, "cancel");
    expect(
        await purgeDue(deps, new Date(DATE.getTime() + 89 * 86400000))
    ).toEqual({ purged: 0 });
    expect(objects.size).toBe(1);
    const due = new Date(DATE.getTime() + 90 * 86400000);
    expect(await purgeDue(deps, due)).toEqual({ purged: 1 });
    expect(objects.size).toBe(0);
    expect(await purgeDue(deps, due)).toEqual({ purged: 0 });
    expect(await db.onboardingQuestionnaire.count()).toBe(0);
    expect(await resolvePortalToken(deps, pathname(token).slice(3))).toEqual({
        error: "inactive",
    });
    expect(
        await db.onboardingDocument.findUnique({
            where: { id: uploadResult.documentId },
        })
    ).toMatchObject({
        purged_at: due,
        storage_key: null,
        extracted: null,
        flags: null,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        source: "CARRIER",
    });
    expect(
        await db.signatureEnvelope.findUnique({ where: { id: env.id } })
    ).toMatchObject({ completed_storage_key: null, filled_storage_key: null });
    for (const file of [signed, filled, manifest])
        await expect(
            deps.documentStore.get(file.storage_key)
        ).rejects.toMatchObject({ code: "document_missing" });
    expect(
        await db.onboardingEvent.findFirst({
            where: { type: "onboarding.purged" },
        })
    ).toMatchObject({
        payload: {
            documents: 1,
            envelope_files: 3,
            questionnaire: 1,
            tokens: 1,
        },
    });
});

test("ready requests retain files until the third calendar anniversary", async () => {
    const row = await createRequest({
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    let operations = row.operations;
    for (const slot of OPERATION_SLOTS)
        operations = verifyOperationItem(
            operations,
            slot === "FACTORING" ? "NOT_FACTORING" : slot,
            { actor: ACTOR, at: DATE }
        );
    await db.$transaction(async (tx) =>
        applyFacetChange(
            tx,
            await lockRequest(tx, row.id),
            { operations },
            DATE
        )
    );
    expect(await refreshed(row.id)).toMatchObject({
        ready_at: DATE,
        purge_after: new Date("2029-11-18T16:00:00Z"),
    });
    expect(await purgeDue(deps, new Date("2029-11-18T15:59:59Z"))).toEqual({
        purged: 0,
    });
    expect(await purgeDue(deps, new Date("2029-11-18T16:00:00Z"))).toEqual({
        purged: 1,
    });
});

test("verify applies only to the document version the closer saw", async () => {
    const row = await createRequest();
    const upload = { source: "CARRIER", actor: { type: "carrier" } };
    const first = await recordUpload(deps, row.id, "W9", pdf, upload);
    const second = await recordUpload(deps, row.id, "W9", pdf, upload);
    await expect(
        act(row, "verify_operation_item", {
            key: "W9",
            document_id: first.documentId,
        })
    ).rejects.toMatchObject({ extra: { code: "document_changed" } });
    await expect(
        act(row, "verify_operation_item", { key: "W9" })
    ).rejects.toMatchObject({
        extra: { code: "document_changed" },
    });
    expect(
        (await refreshed(row.id)).operations.find((i) => i.key === "W9").state
    ).toBe("RECEIVED");
    await act(row, "verify_operation_item", {
        key: "W9",
        document_id: second.documentId,
    });
    expect(
        (await refreshed(row.id)).operations.find((i) => i.key === "W9").state
    ).toBe("VERIFIED");
    // Items with no stored file (carrier profile) verify without a document id.
    await act(row, "verify_operation_item", { key: "CARRIER_PROFILE" });
    expect(
        (await refreshed(row.id)).operations.find(
            (i) => i.key === "CARRIER_PROFILE"
        ).state
    ).toBe("VERIFIED");
});

test("a request that leaves READY reopens its link and drops the 3-year purge date", async () => {
    const row = await createRequest({
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    let operations = row.operations;
    for (const slot of OPERATION_SLOTS)
        operations = verifyOperationItem(
            operations,
            slot === "FACTORING" ? "NOT_FACTORING" : slot,
            { actor: ACTOR, at: DATE }
        );
    await db.$transaction(async (tx) =>
        applyFacetChange(
            tx,
            await lockRequest(tx, row.id),
            { operations },
            DATE
        )
    );
    const token = await issuePortalToken(deps, row.id);
    const raw = pathname(token).slice(3);
    const purgeAfter = (await refreshed(row.id)).purge_after;
    now = new Date(DATE.getTime() + 40 * 86400000);
    expect(await resolvePortalToken(deps, raw)).toEqual({ error: "inactive" });
    await act(row, "unverify_operation_item", { key: "INSURANCE_COI" });
    // The 3-year date stays as a ceiling; the expired link stays dead and a
    // fresh one (the one the next email uses) works.
    expect(await refreshed(row.id)).toMatchObject({
        ready_at: null,
        purge_after: purgeAfter,
    });
    expect(await resolvePortalToken(deps, raw)).toEqual({ error: "inactive" });
    const fresh = await activePortalUrl(deps, row.id);
    expect(fresh).not.toBe(token.url);
    expect(
        Boolean(
            (await resolvePortalToken(deps, new URL(fresh).pathname.slice(3)))
                .row
        )
    ).toBe(true);
});

test("leaving READY inside the 30-day window keeps the carrier's current link", async () => {
    const row = await createRequest({
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    let operations = row.operations;
    for (const slot of OPERATION_SLOTS)
        operations = verifyOperationItem(
            operations,
            slot === "FACTORING" ? "NOT_FACTORING" : slot,
            { actor: ACTOR, at: DATE }
        );
    await db.$transaction(async (tx) =>
        applyFacetChange(
            tx,
            await lockRequest(tx, row.id),
            { operations },
            DATE
        )
    );
    const token = await issuePortalToken(deps, row.id);
    now = new Date(DATE.getTime() + 10 * 86400000);
    await act(row, "unverify_operation_item", { key: "INSURANCE_COI" });
    expect(await activePortalUrl(deps, row.id)).toBe(token.url);
});

test("a form posted without JavaScript (Origin: null) passes only as a same-origin fetch", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const base = pathname(token);
    const body = "csrf=" + csrfToken(config.portal.tokenSecret, token.tokenId);
    const post = (headers) =>
        browser(base + "/not-factoring", {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                ...headers,
            },
            body,
        });
    expect((await post({ Origin: "null" })).status).toBe(403);
    expect(
        (await post({ Origin: "null", "Sec-Fetch-Site": "cross-site" })).status
    ).toBe(403);
    expect((await post({ "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect(
        (
            await post({
                Origin: "https://evil.example",
                "Sec-Fetch-Site": "same-origin",
            })
        ).status
    ).toBe(403);
    const saved = await post({
        Origin: "null",
        "Sec-Fetch-Site": "same-origin",
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("location")).toBe(
        base + "?factoring=saved#factoring"
    );
    const page = await browser(base + "?factoring=saved");
    expect(await page.text()).toContain(
        "We recorded that you don’t use factoring."
    );
    expect(
        (await refreshed(row.id)).operations.find(
            (item) => item.key === "NOT_FACTORING"
        )?.state
    ).toBe("RECEIVED");
});

test("requests from before the portal get retention dates, and purging needs no portal switch", async () => {
    const cancelled = await createRequest({
        portal_flow: false,
        cancelled_at: DATE,
        purge_after: null,
        ready_at: null,
    });
    const ready = await createRequest({
        portal_flow: false,
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
        operations: OPERATION_SLOTS.reduce(
            (items, slot) =>
                verifyOperationItem(
                    items,
                    slot === "FACTORING" ? "NOT_FACTORING" : slot,
                    {
                        actor: ACTOR,
                        at: DATE,
                    }
                ),
            (await createRequest()).operations
        ),
        purge_after: null,
        ready_at: null,
    });
    config = { ...config, portal: { ...config.portal, enabled: false } };
    deps = { ...deps, config };
    expect(
        await purgeDue(deps, new Date(DATE.getTime() + 89 * 86400000))
    ).toEqual({ purged: 0 });
    expect((await refreshed(cancelled.id)).purge_after).toEqual(
        new Date(DATE.getTime() + 90 * 86400000)
    );
    const readyRow = await refreshed(ready.id);
    expect(readyRow.ready_at).not.toBeNull();
    expect(readyRow.purge_after.getUTCFullYear()).toBe(
        readyRow.ready_at.getUTCFullYear() + 3
    );
    expect(
        await purgeDue(deps, new Date(DATE.getTime() + 90 * 86400000))
    ).toEqual({ purged: 1 });
});

test("a portal failure is logged with a code and a redacted path, never the token", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const raw = pathname(token).slice(3);
    const spy = jest
        .spyOn(db.onboardingQuestionnaire, "findUnique")
        .mockRejectedValueOnce(
            Object.assign(new Error("db down"), { code: "P1001" })
        );
    try {
        const response = await browser(pathname(token));
        expect(response.status).toBe(503);
    } finally {
        spy.mockRestore();
    }
    const entry = deps.logger.lines.find(
        (line) => line.code === "portal_request_failed"
    );
    expect(entry).toMatchObject({
        level: "error",
        path: "/p/[token]",
        error: "P1001",
    });
    expect(JSON.stringify(deps.logger.lines)).not.toContain(raw);
});

test("a reissued packet stays in the portal flow and still sends the carrier no SignWell email", async () => {
    const key = randomUUID();
    const { row } = await putRequest(
        deps,
        key,
        requestBody({ idempotency_key: key })
    );
    await approveTestBundle(db, deps.documentStore, {
        makePacket: makeSyntheticPacket,
        layout: syntheticLayout(),
    });
    await deps.onRequestCreated(row);
    const first = await db.signatureEnvelope.findFirst({
        where: { request_id: row.id },
    });
    signature.expire(first.provider_document_id);
    await deps.reconcileSignature(row.id);
    expect((await refreshed(row.id)).signature_state).toBe("EXPIRED");
    const { reissuePacket } = await import(
        "../../src/onboarding/signatureFlow.js"
    );
    await reissuePacket(deps, row.id);
    const envelopes = await db.signatureEnvelope.findMany({
        where: { request_id: row.id },
        orderBy: { created_at: "asc" },
    });
    expect(envelopes).toHaveLength(2);
    expect((await refreshed(row.id)).portal_flow).toBe(true);
    expect(
        signature.documents.get(envelopes[1].provider_document_id).signers[1]
            .sendEmail
    ).toBe(false);
});

test("inactive links show the contact page over HTTP: 31 days after READY, and once purged", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id);
    const base = pathname(token);
    await db.onboardingRequest.update({
        where: { id: row.id },
        data: { ready_at: new Date(now.getTime() - 31 * 86400000) },
    });
    let response = await browser(base);
    expect(response.status).toBe(410);
    expect(await response.text()).toContain(
        "onboarding@iron-wing-dispatching.com"
    );
    await db.onboardingRequest.update({
        where: { id: row.id },
        data: { ready_at: null, purged_at: now },
    });
    response = await browser(base + "/agreement");
    expect(response.status).toBe(410);
});

test("an upload over 15 MB through the page is refused and stores nothing", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const big = Buffer.concat([
        Buffer.from("%PDF-1.7\n"),
        Buffer.alloc(MAX_UPLOAD_BYTES),
    ]);
    const response = await browser(pathname(token) + "/documents/W9", {
        method: "POST",
        headers: { Origin: PORTAL_BASE_URL },
        body: form(token, big, "w9.pdf"),
    });
    expect([303, 413]).toContain(response.status);
    if (response.status === 303)
        expect(response.headers.get("location")).toContain("error=too_large");
    expect(objects.size).toBe(0);
    expect(
        await db.onboardingDocument.count({ where: { request_id: row.id } })
    ).toBe(0);
    expect(
        (await refreshed(row.id)).operations.find((i) => i.key === "W9").state
    ).toBe("PENDING");
});

test("a re-upload request bumps the version and writes one status event", async () => {
    const row = await createRequest();
    await recordUpload(deps, row.id, "W9", pdf, {
        source: "CARRIER",
        actor: { type: "carrier" },
    });
    const before = await refreshed(row.id);
    const events = await eventCount(row.id);
    await act(row, "request_reupload", {
        key: "W9",
        reason: "Page 2 missing.",
    });
    const after = await refreshed(row.id);
    expect(after.version).toBe(before.version + 1);
    expect(await eventCount(row.id)).toBe(events + 1);
    expect(after.operations.find((i) => i.key === "W9")).toMatchObject({
        state: "REUPLOAD_REQUESTED",
        note: "Page 2 missing.",
    });
});

test("staff confirm load board access; the status carries the boards and the page shows it", async () => {
    const row = await createRequest();
    await expect(
        act(row, "confirm_load_board_access", { boards: [] })
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
        act(row, "confirm_load_board_access", { boards: ["OTHER"] })
    ).rejects.toMatchObject({ code: "invalid_request" });
    const events = await eventCount(row.id);
    await act(row, "confirm_load_board_access", {
        boards: ["TRUCKSTOP", "DAT_ONE"],
    });
    expect(await eventCount(row.id)).toBe(events + 1);
    const item = (await refreshed(row.id)).operations.find(
        (i) => i.key === "LOAD_BOARD_ACCESS"
    );
    expect(item).toMatchObject({
        state: "VERIFIED",
        boards: ["DAT_ONE", "TRUCKSTOP"],
        actor: ACTOR,
    });
    const status = await db.onboardingEvent.findFirst({
        where: { request_id: row.id, type: "onboarding.status.v1" },
        orderBy: { version: "desc" },
    });
    expect(
        status.payload.operations.items.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        )
    ).toMatchObject({
        state: "VERIFIED",
        boards: ["DAT_ONE", "TRUCKSTOP"],
    });
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    expect(await (await browser(pathname(token))).text()).toContain(
        "Iron Wing confirmed access to DAT One and Truckstop"
    );
    await act(row, "unverify_operation_item", { key: "LOAD_BOARD_ACCESS" });
    expect(
        (await refreshed(row.id)).operations.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        ).state
    ).toBe("PENDING");
});

test("requests already in flight get the load board item; READY ones keep their six items", async () => {
    const { addLoadBoardItem } = await import(
        "../../src/onboarding/loadBoardBackfill.js"
    );
    const strip = (ops) => ops.filter((i) => i.key !== "LOAD_BOARD_ACCESS");
    const open = await createRequest();
    await db.onboardingRequest.update({
        where: { id: open.id },
        data: { operations: strip(open.operations) },
    });
    const ready = await createRequest();
    await db.onboardingRequest.update({
        where: { id: ready.id },
        data: { operations: strip(ready.operations), ready_at: DATE },
    });
    const before = await eventCount(open.id);
    expect(await addLoadBoardItem(db)).toBe(1);
    expect(await eventCount(open.id)).toBe(before + 1);
    expect(
        (await refreshed(open.id)).operations.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        )
    ).toMatchObject({ state: "PENDING" });
    expect((await refreshed(ready.id)).operations).toHaveLength(6);
    expect(await addLoadBoardItem(db)).toBe(0);
});

test("the load board step names the dispatcher: the default, or one a closer assigns", async () => {
    config = {
        ...config,
        dispatcher: {
            name: "Nick Kalas",
            email: "nick@iron-wing-dispatching.com",
        },
    };
    deps = { ...deps, config };
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    let page = await (await browser(pathname(token))).text();
    expect(page).toContain("Nick Kalas");
    expect(page).toContain("nick@iron-wing-dispatching.com");
    expect(page).not.toContain("Ask Iron Wing for your dispatcher");
    await act(row, "set_dispatcher", {
        name: "Dana Ortiz",
        email: "Dana@Iron-Wing-Dispatching.com",
    });
    page = await (await browser(pathname(token))).text();
    expect(page).toContain("Dana Ortiz");
    expect(page).toContain("dana@iron-wing-dispatching.com");
    const status = await db.onboardingEvent.findFirst({
        where: { request_id: row.id, type: "onboarding.status.v1" },
        orderBy: { version: "desc" },
    });
    expect(status.payload.portal.dispatcher).toEqual({
        name: "Dana Ortiz",
        email: "dana@iron-wing-dispatching.com",
        source: "ASSIGNED",
    });
    await expect(
        act(row, "set_dispatcher", { name: "X", email: "not-an-email" })
    ).rejects.toMatchObject({
        code: "invalid_request",
    });
    await act(row, "set_dispatcher", { name: null, email: null });
    expect(await (await browser(pathname(token))).text()).toContain(
        "Nick Kalas"
    );
});

test("'Added' records the board the carrier set up and the page says what happens next", async () => {
    config = {
        ...config,
        dispatcher: {
            name: "Nick Kalas",
            email: "nick@iron-wing-dispatching.com",
        },
    };
    deps = { ...deps, config };
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const csrf = csrfToken(config.portal.tokenSecret, token.tokenId);
    const post = (body) =>
        browser(pathname(token) + "/load-board", {
            method: "POST",
            headers: {
                Origin: PORTAL_BASE_URL,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ csrf, ...body }).toString(),
        });
    let response = await post({ board: "DAT_ONE" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("#load-boards");
    expect((await post({ board: "OTHER" })).headers.get("location")).toContain(
        "error=load_board_name"
    );
    await post({ board: "OTHER", other: " 123Loadboard " });
    expect((await post({ board: "BOGUS" })).status).toBe(400);
    const item = (await refreshed(row.id)).operations.find(
        (i) => i.key === "LOAD_BOARD_ACCESS"
    );
    expect(item).toMatchObject({
        state: "RECEIVED",
        reported: ["DAT_ONE", "OTHER"],
        reported_note: "123Loadboard",
    });
    const page = await (await browser(pathname(token) + "?board=added")).text();
    expect(page).toContain(
        "You added a seat on DAT One and 123Loadboard for Nick Kalas."
    );
    expect(page).toContain("Iron Wing will check access and confirm it here.");
    expect(page).not.toContain("tell Iron Wing which board is ready");
    const status = await db.onboardingEvent.findFirst({
        where: { request_id: row.id, type: "onboarding.status.v1" },
        orderBy: { version: "desc" },
    });
    expect(
        status.payload.operations.items.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        )
    ).toMatchObject({
        state: "RECEIVED",
        reported_boards: ["DAT_ONE", "OTHER"],
        reported_note: "123Loadboard",
    });
    await act(row, "confirm_load_board_access", { boards: ["DAT_ONE"] });
    expect(
        (await post({ board: "TRUCKSTOP" })).headers.get("location")
    ).toContain("#load-boards");
    expect(
        (await refreshed(row.id)).operations.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        ).state
    ).toBe("VERIFIED");
});

const readyOperations = (row, { factoring = false } = {}) => {
    let operations = row.operations;
    for (const slot of OPERATION_SLOTS) {
        if (slot === "FACTORING" && !factoring) continue;
        if (slot === "LOAD_BOARD_ACCESS") continue;
        operations = verifyOperationItem(
            operations,
            slot === "FACTORING" ? "NOT_FACTORING" : slot,
            { actor: ACTOR, at: DATE }
        );
    }
    return confirmLoadBoardAccess(operations, {
        boards: ["DAT_ONE"],
        actor: ACTOR,
        at: DATE,
    });
};

test("READY portal request stays READY after a factoring re-upload request", async () => {
    const row = await createRequest({
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    await recordUpload(deps, row.id, "FACTORING_NOA", pdf, {
        source: "CARRIER",
        actor: { type: "carrier" },
    });
    const fresh = await refreshed(row.id);
    await db.$transaction(async (tx) =>
        applyFacetChange(
            tx,
            await lockRequest(tx, row.id),
            { operations: readyOperations(fresh) },
            DATE
        )
    );
    const ready = await refreshed(row.id);
    expect(ready.ready_at).toEqual(DATE);
    await act(row, "request_reupload", {
        key: "FACTORING_NOA",
        reason: "Wrong factoring company.",
    });
    const after = await refreshed(row.id);
    expect(after.ready_at).toEqual(DATE);
    expect(deriveReadiness(facetsOf(after)).readiness).toBe("READY");
});

test("backfill readies a portal request whose only gap was factoring; email flow untouched", async () => {
    const { readyAfterFactoringChange } = await import(
        "../../src/onboarding/factoringBackfill.js"
    );
    const portal = await createRequest({
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    const email = await createRequest({
        portal_flow: false,
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    });
    for (const row of [portal, email])
        await db.onboardingRequest.update({
            where: { id: row.id },
            data: { operations: readyOperations(row) },
        });
    const events = await eventCount(portal.id);
    expect(await readyAfterFactoringChange(db, DATE)).toBe(1);
    const readied = await refreshed(portal.id);
    expect(readied.ready_at).toEqual(DATE);
    expect(await eventCount(portal.id)).toBe(events + 1);
    expect(
        (await db.client.findUnique({ where: { id: readied.client_id } }))
            .status
    ).toBe("ACTIVE");
    expect((await refreshed(email.id)).ready_at).toBeNull();
    expect(await readyAfterFactoringChange(db, DATE)).toBe(0);
});

test("a board added on the portal after confirmation is recorded and the item stays VERIFIED", async () => {
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const csrf = csrfToken(config.portal.tokenSecret, token.tokenId);
    const post = (board) =>
        browser(pathname(token) + "/load-board", {
            method: "POST",
            headers: {
                Origin: PORTAL_BASE_URL,
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({ csrf, board }).toString(),
        });
    await post("DAT_ONE");
    await act(row, "confirm_load_board_access", { boards: ["DAT_ONE"] });
    expect((await post("TRUCKSTOP")).status).toBe(303);
    const item = (await refreshed(row.id)).operations.find(
        (i) => i.key === "LOAD_BOARD_ACCESS"
    );
    expect(item).toMatchObject({
        state: "VERIFIED",
        boards: ["DAT_ONE"],
        reported: ["DAT_ONE", "TRUCKSTOP"],
    });
    const status = await db.onboardingEvent.findFirst({
        where: { request_id: row.id, type: "onboarding.status.v1" },
        orderBy: { version: "desc" },
    });
    expect(
        status.payload.operations.items.find(
            (i) => i.key === "LOAD_BOARD_ACCESS"
        ).reported_boards
    ).toEqual(["DAT_ONE", "TRUCKSTOP"]);
});

test("a no-JS post of three gallery photos stores one 3-page PDF version; a refused set stores nothing", async () => {
    const { PDFDocument } = await import("pdf-lib");
    const sharp = (await import("sharp")).default;
    const photo = await sharp({
        create: {
            width: 900,
            height: 1200,
            channels: 3,
            background: { r: 240, g: 240, b: 240 },
        },
    })
        .jpeg()
        .toBuffer();
    const row = await createRequest();
    const token = await issuePortalToken(deps, row.id, {
        revokeExisting: true,
    });
    const post = (files) => {
        const data = new FormData();
        data.set("csrf", csrfToken(config.portal.tokenSecret, token.tokenId));
        for (const [bytes, name, type] of files)
            data.append("file", new Blob([bytes], { type }), name);
        // The unused camera input arrives as an empty part.
        data.append(
            "file",
            new Blob([], { type: "application/octet-stream" }),
            ""
        );
        return browser(pathname(token) + "/documents/INSURANCE_COI", {
            method: "POST",
            headers: { Origin: PORTAL_BASE_URL },
            body: data,
        });
    };
    let response = await post([
        [photo, "p1.jpg", "image/jpeg"],
        [photo, "p2.jpg", "image/jpeg"],
        [photo, "p3.jpg", "image/jpeg"],
    ]);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(
        "uploaded=INSURANCE_COI"
    );
    const documents = await db.onboardingDocument.findMany({
        where: { request_id: row.id },
    });
    expect(documents).toHaveLength(1);
    expect(documents[0].media_type).toBe("application/pdf");
    const stored = await deps.fileStore.get(documents[0].storage_key, {
        expectedSha256: documents[0].sha256,
    });
    expect((await PDFDocument.load(stored)).getPageCount()).toBe(3);
    const before = objects.size;
    response = await post([
        [pdf, "a.pdf", "application/pdf"],
        [photo, "p.jpg", "image/jpeg"],
    ]);
    expect(response.headers.get("location")).toContain("error=mixed_files");
    expect(objects.size).toBe(before);
    expect(
        await db.onboardingDocument.count({ where: { request_id: row.id } })
    ).toBe(1);
});
