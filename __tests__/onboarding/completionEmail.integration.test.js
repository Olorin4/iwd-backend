// R15: one combined email at signature completion (signed copy attached,
// payment link, documents list), exactly once per request.
import { createHash } from "node:crypto";
import { prisma } from "../../src/prismaClient";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import { reconcileOnce } from "../../src/onboarding/workers";
import { recoverRequestSteps } from "../../src/onboarding/recovery";
import { reconcilePayment } from "../../src/onboarding/paymentFlow";
import { sendCompletionEmail } from "../../src/onboarding/documentsFlow";
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

const EXPECTED_TEXT = (url) =>
    [
        "Hello Sam Example,",
        "",
        "Thank you. Your dispatch service agreement, limited power of attorney and payment authorization are now signed by both parties. Your signed copy is attached to this email.",
        "",
        `Payment method: if you haven't finished saving it yet, use Stripe's secure page here: ${url}. Nothing is charged when you save it. Never send card or bank account numbers by email.`,
        "",
        "Documents we need before we start dispatching for Example Freight LLC. Please reply to this email with:",
        "1. A signed W-9 form",
        "2. Your certificate of insurance",
        "3. A copy of your operating authority (MC 123456)",
        "4. Your factoring company's notice of assignment, or reply \"no factoring\" if you don't use one",
        "5. Your carrier profile: equipment, preferred lanes, minimum rates and any freight you won't haul (a short list in the email is fine)",
    ].join("\n");

it("sends one combined email with the signed copy, the payment link and the documents list", async () => {
    const row = await completed();
    await queue.drain();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("owner@example.test");
    expect(mail.from).toBe("onboarding@example.test");
    expect(mail.replyTo).toBe("ops@example.test");
    expect(mail.subject).toBe(
        `Your signed Iron Wing agreement and next steps — Example Freight LLC (ref ${row.id.slice(0, 8)})`
    );
    const url = mail.text.match(
        /https:\/\/api\.example\.test\/onboarding\/continue\/[^\s]+?(?=\. Nothing)/
    )[0];
    expect(mail.text).toBe(EXPECTED_TEXT(url));
    expect(mail.text).not.toMatch(/[{}]/);
    expect(mail.subject).not.toMatch(/[{}]/);

    const [attachment] = mail.attachments;
    expect(mail.attachments).toHaveLength(1);
    expect(attachment.filename).toBe(
        "Iron-Wing-agreement-example-freight-llc.pdf"
    );
    expect(attachment.contentType).toBe("application/pdf");
    const envelope = await prisma.signatureEnvelope.findFirst({
        where: { state: "COMPLETED" },
    });
    expect(createHash("sha256").update(attachment.content).digest("hex")).toBe(
        envelope.completed_sha256
    );

    const fresh = await request();
    expect(fresh.completion_emailed_at).not.toBeNull();
    expect(fresh.documents_requested_at).not.toBeNull();
    expect(fresh.payment_state).toBe("LINK_SENT");
    // It is the payment-link email: the setup counts as emailed and the
    // payment reconcile never sends another.
    const setup = await prisma.paymentSetup.findFirst();
    expect(setup.emailed_at).not.toBeNull();
    await reconcilePayment(deps, row.id);
    await reconcileOnce(deps);
    await recoverRequestSteps(deps, row.id);
    await app.call("POST", `/requests/${KEY}/actions/reconcile`, {
        actor: ACTOR,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(
        await prisma.documentAccessLog.count({
            where: { document: `signed_packet_email:${envelope.id}` },
        })
    ).toBe(1);
});

it("is sent exactly once when the webhook task, reconcile and recovery race, and after a restart", async () => {
    const row = await completed();
    const tasks = queue.tasks.splice(0);
    await Promise.all([
        ...tasks.map((t) => t()),
        reconcileOnce(deps),
        recoverRequestSteps(deps, row.id),
        sendCompletionEmail(deps, row.id),
        sendCompletionEmail(deps, row.id),
    ]);
    await queue.drain();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // A restarted process (fresh deps) never sends it again.
    deps = makeDeps();
    await reconcileOnce(deps);
    await deps.onSignatureCompleted(row.id);
    await queue.drain();
    expect(sendEmail).toHaveBeenCalledTimes(1);
});

it("a send failure releases the claim and the reconcile pass retries once", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const row = await completed();
    await queue.drain();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    let fresh = await request();
    expect(fresh.completion_emailed_at).toBeNull();
    expect(fresh.documents_requested_at).toBeNull();
    expect(logger.lines.map((l) => l.code)).toContain(
        "onboarding_completion_email_failed"
    );
    await reconcileOnce(deps);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    fresh = await request();
    expect(fresh.completion_emailed_at).not.toBeNull();
    expect(fresh.documents_requested_at).not.toBeNull();
    await reconcileOnce(deps);
    await reconcilePayment(deps, row.id);
    expect(sendEmail).toHaveBeenCalledTimes(2);
});

it("never sends a document that fails its sha256 check", async () => {
    const row = await completed();
    queue.tasks.splice(0);
    await prisma.signatureEnvelope.updateMany({
        where: { request_id: row.id, state: "COMPLETED" },
        data: { completed_sha256: "0".repeat(64) },
    });
    expect(await sendCompletionEmail(deps, row.id)).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    expect((await request()).completion_emailed_at).toBeNull();
    expect(logger.lines).toContainEqual(
        expect.objectContaining({
            code: "onboarding_completion_document_unavailable",
            reason: "document_hash_mismatch",
        })
    );
});

it("is not sent for a cancelled request", async () => {
    const row = await completed();
    queue.tasks.splice(0);
    await prisma.onboardingRequest.update({
        where: { id: row.id },
        data: { cancelled_at: new Date() },
    });
    await recoverRequestSteps(deps, row.id);
    await reconcileOnce(deps);
    expect(await sendCompletionEmail(deps, row.id)).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
});

it("resend_payment_link still sends the plain payment-link email, with the reply-to", async () => {
    await completed();
    await queue.drain();
    const res = await app.call(
        "POST",
        `/requests/${KEY}/actions/resend_payment_link`,
        { actor: ACTOR }
    );
    expect(res.status).toBe(200);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const mail = sendEmail.mock.calls[1][0];
    expect(mail.subject).toBe(
        "Next step: save your payment method for Iron Wing"
    );
    expect(mail.replyTo).toBe("ops@example.test");
    expect(mail.attachments).toBeUndefined();
});
