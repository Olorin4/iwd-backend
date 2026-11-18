import { prisma } from "../../src/prismaClient";
import { continueUrl } from "../../src/onboarding/continueToken";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { recoverRequestSteps } from "../../src/onboarding/recovery";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import {
    reconcilePayment,
    issuePaymentLink,
} from "../../src/onboarding/paymentFlow";
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
import { createFakeStripe, stripeEvent } from "./fakeStripe";

serializeSuite();

const KEY = fixture("onboarding.request.v1").idempotency_key;
let app, deps, config, queue, signature, stripe, sendEmail;

beforeEach(async () => {
    await cleanTables(prisma);
    config = testConfig(tempDir());
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

const request = () =>
    prisma.onboardingRequest.findUnique({ where: { idempotency_key: KEY } });
const setups = () =>
    prisma.paymentSetup.findMany({ orderBy: { created_at: "asc" } });

async function signed(termsOverrides = {}) {
    await app.call("PUT", `/requests/${KEY}`, requestBody({}, termsOverrides));
    await queue.drain();
    const [envelope] = await prisma.signatureEnvelope.findMany();
    signature.complete(envelope.provider_document_id);
    await deps.reconcileSignature(envelope.request_id);
    await queue.drain();
    return request();
}

const postStripe = (event) =>
    app.call("POST", "/webhooks/stripe", event.payload, {
        auth: false,
        headers: { "Stripe-Signature": event.header },
    });

it("issues the payment link only after the signature completes, emailing once", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const row = await request();
    expect(await issuePaymentLink(deps, row.id)).toEqual({
        skipped: "signature_not_completed",
    });
    expect(stripe.calls.createSetupSession).toBe(0);

    const done = await signed();
    expect(done.payment_state).toBe("LINK_SENT");
    const [setup] = await setups();
    expect(setup.state).toBe("OPEN");
    const session = stripe.sessions.get(setup.checkout_session_id);
    expect(session.input.methods).toEqual(["card", "us_bank_account"]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.to).toBe("owner@example.test");
    expect(mail.text).toMatch(
        /https:\/\/api\.example\.test\/onboarding\/continue\//
    );
    expect(mail.text).not.toMatch(/[{}]|onboarding_request|cs_test|seti_/);
    // Repeated completion processing never emails twice.
    await issuePaymentLink(deps, row.id);
    await deps.onSignatureCompleted(row.id);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(stripe.calls.createSetupSession).toBe(1);
    const client = await prisma.client.findFirst();
    expect(client.stripe_customer_id).toMatch(/^cus_/);
});

it("reconcile emails a link whose email never went out, exactly once", async () => {
    // SMTP fails on the first attempt: the claim is released (emailed_at null).
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const done = await signed();
    expect(done.payment_state).toBe("LINK_SENT");
    let [setup] = await setups();
    expect(setup.emailed_at).toBeNull();
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // R15: the payment reconcile leaves the combined email to the recovery
    // sweep (one attempt per reconcile pass).
    await reconcilePayment(deps, done.id);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await recoverRequestSteps(deps, done.id);
    [setup] = await setups();
    expect(setup.emailed_at).not.toBeNull();
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].to).toBe("owner@example.test");

    // Further reconciles never email again, and no new session is created.
    await reconcilePayment(deps, done.id);
    await reconcilePayment(deps, done.id);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(stripe.calls.createSetupSession).toBe(1);
});

it("reconcile never emails a link the customer has already completed", async () => {
    sendEmail.mockRejectedValueOnce(new Error("smtp down"));
    const done = await signed();
    const [setup] = await setups();
    expect(setup.emailed_at).toBeNull();
    // The customer completes the session (e.g. via the post-signing redirect)
    // before any retry of the email.
    stripe.complete(setup.checkout_session_id, { type: "card" });
    await reconcilePayment(deps, done.id);
    expect(sendEmail).toHaveBeenCalledTimes(1); // only the failed first attempt
    expect((await request()).payment_state).toBe("READY");
});

it("allows exactly the payment methods in the terms", async () => {
    await signed({
        payment_methods: ["us_bank_account"],
        primary_payment_method: null,
    });
    const [setup] = await setups();
    expect(
        stripe.sessions.get(setup.checkout_session_id).input.methods
    ).toEqual(["us_bank_account"]);
});

it("continue link re-checks the signature, then redirects to the open session", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    const [envelope] = await prisma.signatureEnvelope.findMany();
    // The SignWell redirect (reached by the carrier, who signs last) and the
    // payment email both use the continue link.
    expect(
        signature.documents.get(envelope.provider_document_id).metadata
            .redirect_url
    ).toMatch(/\/onboarding\/continue\//);
    const token = continueUrl(config, envelope.request_id).split(
        "/continue/"
    )[1];
    const waiting = await app.call("GET", `/continue/${token}`, undefined, {
        auth: false,
    });
    expect(waiting.status).toBe(202);
    expect(waiting.text).toMatch(/If you are the carrier, refresh this page/);

    signature.complete(envelope.provider_document_id);
    const go = await app.call("GET", `/continue/${token}`, undefined, {
        auth: false,
    });
    expect(go.status).toBe(303);
    const [setup] = await setups();
    expect(go.headers.get("location")).toBe(setup.checkout_url);
    await queue.drain();
    const again = await app.call("GET", `/continue/${token}`, undefined, {
        auth: false,
    });
    expect(again.headers.get("location")).toBe(setup.checkout_url);
    expect(stripe.calls.createSetupSession).toBe(1);
    expect(
        (
            await app.call("GET", `/continue/${token}x`, undefined, {
                auth: false,
            })
        ).status
    ).toBe(410);
});

it("verified webhook → re-fetch → READY with method stored on PaymentSetup and Client", async () => {
    await signed();
    const [setup] = await setups();
    const pm = stripe.complete(setup.checkout_session_id, {
        type: "card",
        last4: "4242",
    });
    // Forged signature and wrong mode are refused.
    const forged = stripeEvent("whsec_wrong", {
        type: "checkout.session.completed",
        object: { id: setup.checkout_session_id },
    });
    expect((await postStripe(forged)).status).toBe(400);
    const live = stripeEvent(config.stripe.webhookSecret, {
        type: "checkout.session.completed",
        livemode: true,
        object: { id: setup.checkout_session_id },
    });
    expect((await postStripe(live)).status).toBe(400);
    expect((await request()).payment_state).toBe("LINK_SENT");

    const event = stripeEvent(config.stripe.webhookSecret, {
        id: "evt_done_1",
        type: "checkout.session.completed",
        object: { id: setup.checkout_session_id, status: "complete" },
    });
    expect((await postStripe(event)).status).toBe(200);
    expect((await postStripe(event)).status).toBe(200);
    const row = await request();
    expect(row).toMatchObject({
        payment_state: "READY",
        payment_method_type: "card",
        payment_last4: "4242",
    });
    const stored = (await setups())[0];
    expect(stored).toMatchObject({
        state: "SUCCEEDED",
        payment_method_id: pm.id,
        brand: "visa",
        last4: "4242",
    });
    const client = await prisma.client.findFirst();
    expect(client).toMatchObject({
        payment_method_id: pm.id,
        payment_method_type: "card",
        payment_last4: "4242",
    });
    expect(
        await prisma.providerWebhookReceipt.count({
            where: { provider: "stripe" },
        })
    ).toBe(1);
});

it("ignores a payment method that belongs to another customer", async () => {
    await signed();
    const [setup] = await setups();
    stripe.complete(setup.checkout_session_id, {
        customer: "cus_someone_else",
    });
    await postStripe(
        stripeEvent(config.stripe.webhookSecret, {
            type: "checkout.session.completed",
            object: { id: setup.checkout_session_id },
        })
    );
    expect((await request()).payment_state).toBe("LINK_SENT");
    expect(
        deps.logger.lines.some(
            (l) => l.code === "onboarding_payment_method_rejected"
        )
    ).toBe(true);
});

it("ACH micro-deposits → PENDING_VERIFICATION → reconcile → READY", async () => {
    await signed();
    const [setup] = await setups();
    stripe.microdeposits(setup.checkout_session_id);
    await postStripe(
        stripeEvent(config.stripe.webhookSecret, {
            type: "setup_intent.requires_action",
            object: {
                id: stripe.sessions.get(setup.checkout_session_id).setup_intent,
            },
        })
    );
    expect((await request()).payment_state).toBe("PENDING_VERIFICATION");
    expect((await app.call("GET", `/requests/${KEY}`)).json.readiness).toBe(
        "IN_PROGRESS"
    );
    stripe.complete(setup.checkout_session_id, {
        type: "us_bank_account",
        last4: "6789",
    });
    await reconcilePayment(deps, (await request()).id);
    expect(await request()).toMatchObject({
        payment_state: "READY",
        payment_method_type: "us_bank_account",
        payment_last4: "6789",
    });
});

it("setup failure and session expiry → FAILED → resend issues a new session and email", async () => {
    await signed();
    let [setup] = await setups();
    stripe.failSetup(setup.checkout_session_id);
    await postStripe(
        stripeEvent(config.stripe.webhookSecret, {
            type: "setup_intent.setup_failed",
            object: {
                id: stripe.sessions.get(setup.checkout_session_id).setup_intent,
            },
        })
    );
    expect((await app.call("GET", `/requests/${KEY}`)).json).toMatchObject({
        payment: { state: "FAILED" },
        readiness: "BLOCKED",
        blocked: { code: "setup_failed", action: "resend_payment_link" },
    });
    await issuePaymentLink(deps, setup.request_id, { mode: "resend" });
    expect((await request()).payment_state).toBe("LINK_SENT");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    [, setup] = await setups();
    stripe.sessions.get(setup.checkout_session_id).status = "expired";
    await postStripe(
        stripeEvent(config.stripe.webhookSecret, {
            type: "checkout.session.expired",
            object: { id: setup.checkout_session_id },
        })
    );
    expect(await request()).toMatchObject({
        payment_state: "FAILED",
        payment_code: "checkout_expired",
    });
});

it("a Stripe failure while creating the session blocks with resend_payment_link", async () => {
    stripe.fail.createSetupSession = "api_connection_error";
    await signed();
    expect(await request()).toMatchObject({
        payment_state: "FAILED",
        payment_code: "stripe_session_failed",
    });
    // R15: the combined email (continue link, signed copy) still goes out.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0].attachments).toHaveLength(1);
    await issuePaymentLink(deps, (await request()).id, { mode: "resend" });
    expect((await request()).payment_state).toBe("LINK_SENT");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(sendEmail.mock.calls[1][0].subject).toBe(
        "Next step: save your payment method for Iron Wing"
    );
});

it("a concurrent webhook and reconcile record READY once (one status event)", async () => {
    await signed();
    const [setup] = await setups();
    stripe.complete(setup.checkout_session_id);
    let clock = Date.now();
    deps.now = () => new Date((clock += 5));
    // Both paths reach the locked write having seen the setup as not done.
    const retrieve = stripe.retrievePaymentMethod.bind(stripe);
    let arrived = 0;
    let release;
    const barrier = new Promise((resolve) => (release = resolve));
    stripe.retrievePaymentMethod = async (id) => {
        arrived += 1;
        if (arrived === 2) release();
        await barrier;
        return retrieve(id);
    };
    const event = stripeEvent(config.stripe.webhookSecret, {
        type: "checkout.session.completed",
        object: { id: setup.checkout_session_id },
    });
    const ready = queue.tasks.length;
    await Promise.all([
        postStripe(event),
        reconcilePayment(deps, setup.request_id),
    ]);
    expect((await request()).payment_state).toBe("READY");
    const readyEvents = (
        await prisma.onboardingEvent.findMany({
            where: { type: "onboarding.status.v1" },
        })
    ).filter((e) => e.payload.payment.state === "READY");
    expect(readyEvents).toHaveLength(1);
    expect(queue.tasks.length - ready).toBe(1);
});
