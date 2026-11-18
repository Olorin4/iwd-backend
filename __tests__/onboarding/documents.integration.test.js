// R15: checklist RECEIVED state, reminder pause/resume actions and the
// documents reminder sweep.
import { prisma } from "../../src/prismaClient";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import {
    BUNDLE,
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
import { createFakeStripe } from "./fakeStripe";
import { onboardingStatusV1 } from "../../src/onboarding/contracts";

serializeSuite();

const KEY = fixture("onboarding.request.v1").idempotency_key;
const ACTOR = {
    user_id: "55555555-5555-4555-8555-555555555555",
    email: "closer@example.test",
};
let app, deps, config, queue, signature, stripe, sendEmail, logger;

function makeDeps(overrides = {}) {
    return createOnboardingDeps(config, {
        db: prisma,
        logger,
        sendEmail,
        signature,
        stripe,
        schedule: queue.schedule,
        documentStore: deps?.documentStore,
        ...overrides,
    });
}

beforeEach(async () => {
    await cleanTables(prisma);
    const base = testConfig(tempDir());
    config = {
        ...base,
        signature: { ...base.signature, requesterEmail: "ops@example.test" },
    };
    queue = taskQueue();
    signature = createFakeSignatureProvider();
    stripe = createFakeStripe();
    sendEmail = jest.fn().mockResolvedValue({});
    logger = captureLogger();
    deps = undefined;
    deps = makeDeps();
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

/** Both parties signed; the after-commit completion step has not run. */
async function completed() {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const [envelope] = await prisma.signatureEnvelope.findMany();
    signature.complete(envelope.provider_document_id);
    await deps.reconcileSignature(envelope.request_id);
    return request();
}

const action = (name, extra = {}) =>
    app.call("POST", `/requests/${KEY}/actions/${name}`, {
        actor: ACTOR,
        ...extra,
    });
const statusEvents = () =>
    prisma.onboardingEvent.findMany({
        where: { type: "onboarding.status.v1" },
        orderBy: { version: "asc" },
    });

describe("checklist actions", () => {
    it("mark_operation_item_received → RECEIVED, audited, version bump and status event", async () => {
        await completed();
        await queue.drain();
        const before = (await request()).version;
        const res = await action("mark_operation_item_received", {
            key: "INSURANCE_COI",
            note: "COI by email",
        });
        expect(res.status).toBe(200);
        const item = res.json.operations.items.find(
            (i) => i.key === "INSURANCE_COI"
        );
        expect(item.state).toBe("RECEIVED");
        expect(res.json.operations.state).toBe("PENDING");
        const row = await request();
        expect(row.version).toBe(before + 1);
        expect((await statusEvents()).at(-1).payload.operations.items).toEqual(
            res.json.operations.items
        );
        const [audit] = await prisma.onboardingEvent.findMany({
            where: { type: "audit.action.mark_operation_item_received" },
        });
        expect(audit.payload).toMatchObject({
            actor: ACTOR,
            params: { key: "INSURANCE_COI", note: "COI by email" },
            outcome: "item_received",
        });
        // Verify still follows.
        const verified = await action("verify_operation_item", {
            key: "INSURANCE_COI",
        });
        expect(
            verified.json.operations.items.find(
                (i) => i.key === "INSURANCE_COI"
            ).state
        ).toBe("VERIFIED");
    });

    it("refuses to mark a verified item received (409 item_already_verified)", async () => {
        await completed();
        await queue.drain();
        await action("verify_operation_item", { key: "W9" });
        const version = (await request()).version;
        const res = await action("mark_operation_item_received", {
            key: "W9",
        });
        expect(res.status).toBe(409);
        expect(res.json).toEqual({
            error: "action_not_allowed",
            code: "item_already_verified",
        });
        expect((await request()).version).toBe(version);
        const audits = await prisma.onboardingEvent.findMany({
            where: { type: "audit.action.mark_operation_item_received" },
        });
        expect(audits[0].payload.outcome).toBe("refused:item_already_verified");
    });

    it("validates the body", async () => {
        await completed();
        expect(
            (await action("mark_operation_item_received", { key: "W10" }))
                .status
        ).toBe(422);
        expect(
            (await action("set_document_reminders", { paused: "yes" })).status
        ).toBe(422);
        expect((await action("set_document_reminders")).status).toBe(422);
    });

    it("set_document_reminders pauses and resumes, with a status event each time", async () => {
        await completed();
        await queue.drain();
        const v0 = (await request()).version;
        let res = await action("set_document_reminders", { paused: true });
        expect(res.status).toBe(200);
        expect(res.json.operations.reminders_paused).toBe(true);
        expect((await request()).version).toBe(v0 + 1);
        // Same value again: audited, no new version.
        await action("set_document_reminders", { paused: true });
        expect((await request()).version).toBe(v0 + 1);
        res = await action("set_document_reminders", { paused: false });
        expect(res.json.operations.reminders_paused).toBe(false);
        expect((await request()).version).toBe(v0 + 2);
        const outcomes = (
            await prisma.onboardingEvent.findMany({
                where: { type: "audit.action.set_document_reminders" },
                orderBy: { created_at: "asc" },
            })
        ).map((e) => e.payload.outcome);
        expect(outcomes).toEqual([
            "reminders_paused",
            "reminders_paused",
            "reminders_resumed",
        ]);
    });

    it("status carries documents_requested_at and reminders after the completion email", async () => {
        await completed();
        await queue.drain();
        const status = (await app.call("GET", `/requests/${KEY}`)).json;
        expect(onboardingStatusV1.parse(status).operations).toMatchObject({
            reminders_sent: 0,
            reminders_paused: false,
        });
        expect(status.operations.documents_requested_at).toBe(
            (await request()).documents_requested_at.toISOString()
        );
    });

    it("both actions are refused on a cancelled request", async () => {
        await completed();
        await queue.drain();
        await action("cancel");
        expect(
            (await action("mark_operation_item_received", { key: "W9" })).status
        ).toBe(409);
        expect(
            (await action("set_document_reminders", { paused: true })).status
        ).toBe(409);
    });
});
