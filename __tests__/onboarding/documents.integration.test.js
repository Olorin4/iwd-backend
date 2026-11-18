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
import { reconcileOnce } from "../../src/onboarding/workers";
import { sendDueReminder } from "../../src/onboarding/documentsFlow";
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

describe("documents reminders (reconcile worker pass)", () => {
    // Monday 2026-11-16 10:00 New York (EST).
    const REQUESTED = new Date("2026-11-16T15:00:00.000Z");
    const DUE_1 = new Date("2026-11-19T15:00:00.000Z"); // Thu, +3 business days
    const DUE_2 = new Date("2026-11-25T15:00:00.000Z"); // Wed, +7 business days
    let clock;
    const at = (date) => {
        clock = new Date(date);
    };
    const reminders = () =>
        sendEmail.mock.calls
            .map((c) => c[0])
            .filter((m) => m.subject.startsWith("Reminder:"));
    const setRow = (data) =>
        prisma.onboardingRequest.update({
            where: { idempotency_key: KEY },
            data,
        });

    /** Completion email sent; the clock is then controlled by the test. */
    async function requested() {
        await completed();
        await queue.drain();
        expect(sendEmail).toHaveBeenCalledTimes(1);
        await setRow({ documents_requested_at: REQUESTED });
        // Real time until a test sets the clock (signed Outreach calls are
        // checked against deps.now()).
        clock = null;
        deps = makeDeps({ now: () => clock ?? new Date() });
        return request();
    }

    it("sends reminder 1 after 3 and reminder 2 after 7 business days, then stops", async () => {
        const row = await requested();
        at(DUE_1.getTime() - 1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(0);

        at(DUE_1);
        const v = (await request()).version;
        await reconcileOnce(deps);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
        const mail = reminders()[0];
        expect(mail.to).toBe("owner@example.test");
        expect(mail.replyTo).toBe("ops@example.test");
        expect(mail.subject).toBe(
            `Reminder: still needed for your Iron Wing onboarding — Example Freight LLC (ref ${row.id.slice(0, 8)})`
        );
        expect(mail.text).toMatch(
            /^Hello Sam Example,\n\nWe're still missing the following for Example Freight LLC:\n1\. A signed W-9 form\n2\. Your certificate of insurance\n3\. A copy of your operating authority \(MC 123456\)\n4\. .*\n5\. Your carrier profile: .*\nYour payment method: save it on Stripe's secure page here:\nhttps:\/\/api\.example\.test\/onboarding\/continue\/\S+\n\nPlease reply to this email\. If you have questions or need more time, just let us know\.$/
        );
        expect(mail.text).not.toMatch(/[{}]|FLEET|fleet/);
        expect(mail.attachments).toBeUndefined();
        const link = mail.text.match(/^https:\/\/\S+$/m)[0];
        expect(
            mail.html.match(/<a [^>]*>Save your payment method<\/a>/g)
        ).toEqual([expect.stringContaining(`href="${link}"`)]);
        let fresh = await request();
        expect(fresh.reminders_sent).toBe(1);
        expect(fresh.version).toBe(v + 1);
        expect(
            (await statusEvents()).at(-1).payload.operations.reminders_sent
        ).toBe(1);

        at(DUE_2.getTime() - 1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
        at(DUE_2);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(2);
        at(new Date("2027-01-15T15:00:00.000Z"));
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(2);
        fresh = await request();
        expect(fresh.reminders_sent).toBe(2);
    });

    it("lists only missing carrier-facing items and drops the payment line once saved", async () => {
        await requested();
        await action("mark_operation_item_received", { key: "W9" });
        await action("verify_operation_item", { key: "NOT_FACTORING" });
        await action("verify_operation_item", { key: "FLEET_MAPPING" });
        await setRow({ payment_state: "READY" });
        at(DUE_1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
        expect(reminders()[0].text).toBe(
            "Hello Sam Example,\n\n" +
                "We're still missing the following for Example Freight LLC:\n" +
                "1. Your certificate of insurance\n" +
                "2. A copy of your operating authority (MC 123456)\n" +
                "3. Your carrier profile: equipment, preferred lanes, minimum rates, any freight you won't haul and any other preferences you have (a short list in the email is fine)\n\n" +
                "Please reply to this email. If you have questions or need more time, just let us know."
        );
    });

    it("documents all in but payment not saved → only the payment line", async () => {
        await requested();
        for (const key of [
            "W9",
            "INSURANCE_COI",
            "AUTHORITY_VERIFIED",
            "FACTORING_NOA",
            "CARRIER_PROFILE",
        ])
            await action("mark_operation_item_received", { key });
        at(DUE_1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
        expect(reminders()[0].text).toMatch(
            /following for Example Freight LLC:\nYour payment method: save it on Stripe's secure page here:\nhttps:\/\//
        );
    });

    it.each([["READY"], ["PENDING_VERIFICATION"]])(
        "stops when every carrier-facing item is in and payment is %s",
        async (payment) => {
            await requested();
            await action("mark_operation_item_received", { key: "W9" });
            for (const key of [
                "INSURANCE_COI",
                "AUTHORITY_VERIFIED",
                "NOT_FACTORING",
            ])
                await action("verify_operation_item", { key });
            await action("mark_operation_item_received", {
                key: "CARRIER_PROFILE",
            });
            // FLEET_MAPPING (internal) stays PENDING and never matters.
            await setRow({ payment_state: payment });
            at(DUE_2);
            await reconcileOnce(deps);
            expect(reminders()).toHaveLength(0);
            expect((await request()).reminders_sent).toBe(0);
        }
    );

    it("stops while paused and resumes after", async () => {
        await requested();
        await action("set_document_reminders", { paused: true });
        at(DUE_1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(0);
        clock = null;
        await action("set_document_reminders", { paused: false });
        at(DUE_1);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
    });

    it("never reminds a cancelled request", async () => {
        await requested();
        await action("cancel");
        at(DUE_2);
        await reconcileOnce(deps);
        expect(await sendDueReminder(deps, (await request()).id)).toBe(false);
        expect(reminders()).toHaveLength(0);
    });

    it("the reconcile action never sends reminders", async () => {
        await requested();
        // Due long ago at real time; only the worker pass may send it.
        await setRow({
            documents_requested_at: new Date(Date.now() - 30 * 86400000),
        });
        await action("reconcile");
        expect(reminders()).toHaveLength(0);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
    });

    it("each reminder number goes out once under concurrent passes", async () => {
        const row = await requested();
        at(DUE_1);
        await Promise.all([
            reconcileOnce(deps),
            reconcileOnce(deps),
            sendDueReminder(deps, row.id),
            sendDueReminder(deps, row.id),
        ]);
        expect(reminders()).toHaveLength(1);
        expect((await request()).reminders_sent).toBe(1);
    });

    it("a reminder claim left by a crash is retried after 30 minutes, sent once", async () => {
        await requested();
        at(DUE_1);
        await setRow({ reminder_claimed_at: DUE_1, reminder_attempts: 1 });
        at(DUE_1.getTime() + 29 * 60 * 1000);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(0);
        at(DUE_1.getTime() + 31 * 60 * 1000);
        await Promise.all([reconcileOnce(deps), reconcileOnce(deps)]);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(1);
        expect(await request()).toMatchObject({
            reminders_sent: 1,
            reminder_claimed_at: null,
            reminder_attempts: 0,
        });
    });

    it("3 failed attempts stop the reminders (logged once)", async () => {
        await requested();
        at(DUE_1);
        sendEmail.mockRejectedValue(new Error("smtp down"));
        for (let i = 0; i < 5; i += 1) await reconcileOnce(deps);
        expect(reminders()).toHaveLength(3);
        expect(
            logger.lines.filter(
                (l) => l.code === "onboarding_reminder_email_stuck"
            )
        ).toHaveLength(1);
        sendEmail.mockResolvedValue({});
        at(DUE_2);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(3);
        expect((await request()).reminders_sent).toBe(0);
    });

    it("a send failure gives the number back and the next pass retries", async () => {
        await requested();
        at(DUE_1);
        sendEmail.mockRejectedValueOnce(new Error("smtp down"));
        await reconcileOnce(deps);
        expect((await request()).reminders_sent).toBe(0);
        expect(logger.lines.map((l) => l.code)).toContain(
            "onboarding_reminder_email_failed"
        );
        await reconcileOnce(deps);
        expect((await request()).reminders_sent).toBe(1);
        // Two attempts, one delivered.
        expect(reminders()).toHaveLength(2);
        await reconcileOnce(deps);
        expect(reminders()).toHaveLength(2);
    });
});

it("GET /onboarding/payment-saved is a public plain-text page with no request data", async () => {
    for (const path of ["/payment-saved", "/payment-saved?session_id=cs_x"]) {
        const res = await app.call("GET", path, undefined, { auth: false });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expect(res.text).toBe(
            "Your payment method is saved. Nothing has been charged. We've emailed you your signed agreement and a short list of documents we need. You can close this page."
        );
    }
});
