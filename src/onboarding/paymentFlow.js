import {
    applyFacetChange,
    lockRequest,
    receiptExists,
    recordReceipt,
    transition,
} from "./store.js";
import { continueUrl } from "./continueToken.js";
import { paymentLinkEmail } from "./emails.js";
import { completionEmailClaimed, replyToOf } from "./documentsFlow.js";
import {
    getClient,
    setClientPaymentMethod,
    setStripeCustomerId,
} from "../clients/index.js";
import { idOf } from "../payments/index.js";

const log = (deps, code, extra = {}) => deps.logger?.info?.({ code, ...extra });
const ISSUABLE = ["CREATING", "OPEN"];

const openSetup = (db, requestId) =>
    db.paymentSetup.findFirst({
        where: { request_id: requestId, state: { in: ISSUABLE } },
    });

const sessionUsable = (setup, now) =>
    setup?.state === "OPEN" &&
    setup.checkout_url &&
    (!setup.expires_at || setup.expires_at - now > 60000);

/**
 * R15: the combined completion email (documentsFlow) is the payment-link
 * email. A setup counts as emailed once that email has been claimed for its
 * request, so the payment reconcile never sends another.
 */
async function markEmailedIfCompletionSent(deps, setup) {
    if (await completionEmailClaimed(deps.db, setup.request_id))
        await deps.db.paymentSetup.updateMany({
            where: { id: setup.id, emailed_at: null },
            data: { emailed_at: deps.now() },
        });
}

/** The operator's resend: the plain payment-link email, once per setup. */
async function emailResend(deps, setup, row) {
    const { count } = await deps.db.paymentSetup.updateMany({
        where: { id: setup.id, emailed_at: null },
        data: { emailed_at: deps.now() },
    });
    if (count !== 1) return false;
    const { subject, text, html } = paymentLinkEmail({
        terms: row.terms,
        url: continueUrl(deps.config, row.id, deps.now()),
        baseUrl: deps.config.publicBaseUrl,
    });
    try {
        await deps.sendEmail({
            from: deps.config.email.from,
            to: row.terms.recipient_email,
            ...replyToOf(deps.config),
            subject,
            text,
            html,
        });
        log(deps, "onboarding_payment_link_emailed");
        return true;
    } catch {
        await deps.db.paymentSetup.update({
            where: { id: setup.id },
            data: { emailed_at: null },
        });
        deps.logger?.error?.({ code: "onboarding_payment_email_failed" });
        return false;
    }
}

/**
 * Issues a Checkout setup session after the signature is COMPLETED.
 * mode "initial": after signing (the link goes out in the R15 combined
 * completion email, sent by the caller; see deps.onSignatureCompleted).
 * mode "resend": operator action; supersedes any open session, emails again.
 * mode "continue": the continue link needs a usable session (no email).
 * Returns { setup } or { skipped: code }.
 */
export async function issuePaymentLink(
    deps,
    requestId,
    { mode = "initial" } = {}
) {
    const { db } = deps;
    const now = deps.now();
    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (!row || row.cancelled_at) return { skipped: "request_closed" };
    if (row.signature_state !== "COMPLETED")
        return { skipped: "signature_not_completed" };
    const allowed = {
        initial: ["NOT_STARTED"],
        resend: ["LINK_SENT", "FAILED"],
        continue: ["NOT_STARTED", "LINK_SENT", "FAILED"],
    }[mode];
    if (!allowed.includes(row.payment_state))
        return { skipped: "payment_state" };

    const existing = await openSetup(db, requestId);
    if (existing && mode !== "resend") {
        if (sessionUsable(existing, now)) {
            if (mode === "initial")
                await markEmailedIfCompletionSent(deps, existing);
            return { setup: existing };
        }
        if (existing.state === "CREATING") return { skipped: "in_progress" };
    }
    if (existing) {
        await db.paymentSetup.update({
            where: { id: existing.id },
            data: { state: mode === "resend" ? "SUPERSEDED" : "EXPIRED" },
        });
        if (existing.checkout_session_id && mode === "resend")
            await deps.stripe
                .expireCheckoutSession(existing.checkout_session_id)
                .catch(() => null);
    }

    let setup;
    try {
        setup = await db.paymentSetup.create({
            data: { request_id: requestId, state: "CREATING" },
        });
    } catch (error) {
        if (error?.code === "P2002") return { skipped: "in_progress" };
        throw error;
    }
    try {
        const client = await getClient(db, row.client_id);
        const { customerId } = await deps.stripe.ensureCustomer({
            clientId: client.id,
            name: client.legal_name,
            email: client.primary_email,
            existingId: client.stripe_customer_id,
        });
        if (!client.stripe_customer_id)
            await setStripeCustomerId(db, client.id, customerId);
        const session = await deps.stripe.createSetupSession({
            customerId,
            clientId: client.id,
            requestId,
            paymentSetupId: setup.id,
            methods: row.terms.payment_methods,
            successUrl: deps.config.stripe.successUrl,
            cancelUrl: deps.config.stripe.cancelUrl,
        });
        setup = await db.paymentSetup.update({
            where: { id: setup.id },
            data: {
                state: "OPEN",
                checkout_session_id: session.id,
                checkout_url: session.url,
                expires_at: session.expiresAt
                    ? new Date(session.expiresAt * 1000)
                    : null,
            },
        });
    } catch (error) {
        await db.paymentSetup.update({
            where: { id: setup.id },
            data: {
                state: "FAILED",
                last_error_code: error?.code ?? "stripe_call_failed",
            },
        });
        await transition(db, requestId, (r) =>
            r.payment_state === "READY" ||
            r.payment_state === "PENDING_VERIFICATION"
                ? null
                : {
                      payment_state: "FAILED",
                      payment_code: "stripe_session_failed",
                      payment_at: now,
                  }
        );
        log(deps, "onboarding_payment_session_failed", {
            reason: error?.code ?? "error",
        });
        return { skipped: "stripe_session_failed" };
    }
    await transition(db, requestId, (r) =>
        ["READY", "PENDING_VERIFICATION"].includes(r.payment_state)
            ? null
            : {
                  payment_state: "LINK_SENT",
                  payment_code: null,
                  payment_at: now,
              }
    );
    if (mode === "resend") await emailResend(deps, setup, row);
    else await markEmailedIfCompletionSent(deps, setup);
    return { setup };
}

/** Applies a re-fetched SetupIntent to its PaymentSetup after ownership checks. */
async function applySetupIntent(deps, setup, intent) {
    const { db } = deps;
    const now = deps.now();
    const row = await db.onboardingRequest.findUnique({
        where: { id: setup.request_id },
    });
    const client = await getClient(db, row.client_id);
    if (
        !client.stripe_customer_id ||
        idOf(intent.customer) !== client.stripe_customer_id ||
        (intent.metadata?.payment_setup_id &&
            intent.metadata.payment_setup_id !== setup.id)
    ) {
        log(deps, "onboarding_stripe_ownership_mismatch");
        return null;
    }
    if (setup.state === "SUCCEEDED") return null;

    if (intent.status === "succeeded") {
        const method = await deps.stripe.retrievePaymentMethod(
            idOf(intent.payment_method)
        );
        const detail = method?.[method?.type];
        if (
            idOf(method.customer) !== client.stripe_customer_id ||
            !row.terms.payment_methods.includes(method.type) ||
            !/^pm_[A-Za-z0-9]+$/.test(method.id) ||
            !/^\d{4}$/.test(detail?.last4 ?? "")
        ) {
            log(deps, "onboarding_payment_method_rejected");
            return null;
        }
        const pm = {
            pmId: method.id,
            type: method.type,
            last4: detail.last4,
            brand:
                method.type === "card"
                    ? (detail.brand ?? null)
                    : (detail.bank_name ?? null),
        };
        const result = await db.$transaction(async (tx) => {
            const locked = await lockRequest(tx, row.id);
            // Re-check under the lock: a concurrent webhook and reconcile
            // must emit one status event and start provisioning once.
            const current = await tx.paymentSetup.findUnique({
                where: { id: setup.id },
            });
            if (current?.state === "SUCCEEDED")
                return { row: locked, changed: false, status: null };
            await tx.paymentSetup.update({
                where: { id: setup.id },
                data: {
                    state: "SUCCEEDED",
                    setup_intent_id: intent.id,
                    payment_method_id: pm.pmId,
                    method_type: pm.type,
                    last4: pm.last4,
                    brand: pm.brand,
                    completed_at: now,
                },
            });
            await setClientPaymentMethod(tx, client.id, pm);
            return applyFacetChange(
                tx,
                locked,
                {
                    payment_state: "READY",
                    payment_code: null,
                    payment_method_type: pm.type,
                    payment_last4: pm.last4,
                    payment_at: now,
                },
                now
            );
        });
        if (result.changed) deps.schedule(() => deps.onPaymentReady(row.id));
        return result;
    }

    const pending =
        intent.status === "processing" ||
        (intent.status === "requires_action" &&
            intent.next_action?.type === "verify_with_microdeposits");
    if (pending) {
        await db.paymentSetup.update({
            where: { id: setup.id },
            data: { state: "PENDING_VERIFICATION", setup_intent_id: intent.id },
        });
        return transition(db, row.id, (r) =>
            r.payment_state === "READY"
                ? null
                : {
                      payment_state: "PENDING_VERIFICATION",
                      payment_code: null,
                      payment_at: now,
                  }
        );
    }
    const failed =
        intent.status === "canceled" ||
        (intent.status === "requires_payment_method" &&
            intent.last_setup_error);
    if (failed) {
        await db.paymentSetup.update({
            where: { id: setup.id },
            data: {
                state: "FAILED",
                setup_intent_id: intent.id,
                last_error_code: "setup_failed",
            },
        });
        return transition(db, row.id, (r) =>
            r.payment_state === "READY"
                ? null
                : {
                      payment_state: "FAILED",
                      payment_code: "setup_failed",
                      payment_at: now,
                  }
        );
    }
    return null;
}

async function markSessionExpired(deps, setup) {
    if (!["OPEN", "CREATING"].includes(setup.state)) return null;
    await deps.db.paymentSetup.update({
        where: { id: setup.id },
        data: { state: "EXPIRED" },
    });
    const now = deps.now();
    return transition(deps.db, setup.request_id, async (r, tx) => {
        const others = await tx.paymentSetup.count({
            where: {
                request_id: r.id,
                state: {
                    in: [
                        "CREATING",
                        "OPEN",
                        "PENDING_VERIFICATION",
                        "SUCCEEDED",
                    ],
                },
            },
        });
        if (others > 0 || r.payment_state !== "LINK_SENT") return null;
        return {
            payment_state: "FAILED",
            payment_code: "checkout_expired",
            payment_at: now,
        };
    });
}

async function applySession(deps, setup, sessionId) {
    const session = await deps.stripe.retrieveCheckoutSession(sessionId);
    if (
        session.metadata?.payment_setup_id &&
        session.metadata.payment_setup_id !== setup.id
    )
        return null;
    if (session.status === "expired") return markSessionExpired(deps, setup);
    const intentId = idOf(session.setup_intent);
    if (!intentId) return null;
    return applySetupIntent(
        deps,
        setup,
        await deps.stripe.retrieveSetupIntent(intentId)
    );
}

/**
 * POST /onboarding/webhooks/stripe. Returns an HTTP status. The event is
 * verified on the raw body with this module's own secret, deduplicated, and
 * the objects are re-fetched before anything changes.
 */
export async function handleStripeWebhook(deps, rawBody, signatureHeader) {
    let event;
    try {
        if (!rawBody || !signatureHeader) throw new Error("missing");
        event = await deps.stripe.constructEvent(
            rawBody,
            signatureHeader,
            deps.config.stripe.webhookSecret
        );
    } catch {
        return 400;
    }
    if (event.livemode !== !!deps.config.stripe.live) return 400;
    if (await receiptExists(deps.db, "stripe", event.id)) return 200;
    const object = event.data?.object ?? {};
    if (event.type.startsWith("checkout.session.")) {
        const setup = await deps.db.paymentSetup.findUnique({
            where: { checkout_session_id: object.id ?? "" },
        });
        if (setup) await applySession(deps, setup, setup.checkout_session_id);
    } else if (event.type.startsWith("setup_intent.")) {
        const intent = await deps.stripe.retrieveSetupIntent(object.id);
        const setupId = intent.metadata?.payment_setup_id;
        const setup = /^[0-9a-f-]{36}$/.test(setupId ?? "")
            ? await deps.db.paymentSetup.findUnique({ where: { id: setupId } })
            : null;
        if (setup) await applySetupIntent(deps, setup, intent);
    }
    await recordReceipt(deps.db, "stripe", event.id);
    return 200;
}

/** Payment facet recovery for the `reconcile` action and the job. */
export async function reconcilePayment(deps, requestId) {
    const find = () =>
        deps.db.paymentSetup.findFirst({
            where: {
                request_id: requestId,
                state: { in: ["OPEN", "PENDING_VERIFICATION"] },
            },
            orderBy: { created_at: "desc" },
        });
    const setup = await find();
    if (!setup?.checkout_session_id) return null;
    // Refresh from Stripe first: a session the customer has already completed
    // must never be emailed again.
    const result = setup.setup_intent_id
        ? await applySetupIntent(
              deps,
              setup,
              await deps.stripe.retrieveSetupIntent(setup.setup_intent_id)
          )
        : await applySession(deps, setup, setup.checkout_session_id);
    // A link whose email never went out (process stopped between creating the
    // session and emailing, or SMTP failed and released the claim) is emailed
    // only while the refreshed session is still OPEN. R15: the first such
    // email is the combined completion email (recovery sweep, claimed once
    // per request); only a failed resend is retried here.
    const fresh = await find();
    if (fresh?.id === setup.id && fresh.state === "OPEN" && !fresh.emailed_at) {
        const row = await deps.db.onboardingRequest.findUnique({
            where: { id: requestId },
        });
        if (row && !row.cancelled_at && row.signature_state === "COMPLETED") {
            // Every setup is marked emailed once the combined email is
            // claimed, so an unmarked setup after that is a resend whose email
            // failed: retry that. Otherwise the combined email is still due;
            // the recovery sweep sends it (one attempt per pass).
            if (await completionEmailClaimed(deps.db, requestId))
                await emailResend(deps, fresh, row);
        }
    }
    return result;
}

export async function openPaymentRequestIds(db) {
    const rows = await db.onboardingRequest.findMany({
        where: {
            cancelled_at: null,
            payment_state: { in: ["LINK_SENT", "PENDING_VERIFICATION"] },
        },
        select: { id: true },
        take: 200,
    });
    return rows.map((r) => r.id);
}

export { sessionUsable, openSetup };

const PAGES = {
    invalid: [
        410,
        "This link is not valid. Please use the most recent email from Iron Wing, or reply to it for a new link.",
    ],
    expired: [
        410,
        "This link has expired. Reply to your Iron Wing email and we will send a new one.",
    ],
    closed: [
        410,
        "This onboarding request is no longer active. Please contact Iron Wing Logistics L.L.C. at info@iron-wing-dispatching.com.",
    ],
    waiting: [
        202,
        "Thank you, your signature is recorded. If you signed for Iron Wing, the packet now goes to the carrier and you can close this page. If you are the carrier, refresh this page in a moment to continue to the payment setup; we also email you the link.",
    ],
    preparing: [
        202,
        "Your payment setup page is being prepared. Please refresh this page in a minute.",
    ],
    done: [
        200,
        "Your payment method is already saved. No further action is needed.",
    ],
    verifying: [
        200,
        "Your bank account is being verified. No further action is needed right now.",
    ],
    unavailable: [
        503,
        "The payment setup page is temporarily unavailable. Please try again in a few minutes.",
    ],
};
const page = (key) => ({ status: PAGES[key][0], text: PAGES[key][1] });

/**
 * GET /onboarding/continue/:token (SignWell redirect_url and the payment
 * email link). Re-checks the signature, then redirects to an open Checkout
 * session or a fresh one. Returns { status, location } or { status, text }.
 */
export async function handleContinue(deps, token, verify) {
    const checked = verify(token);
    if (checked.error) return page(checked.error);
    let row = await deps.db.onboardingRequest.findUnique({
        where: { id: checked.requestId },
    });
    if (!row || row.cancelled_at) return page("closed");
    if (row.signature_state !== "COMPLETED") {
        await deps.reconcileSignature(row.id);
        row = await deps.db.onboardingRequest.findUnique({
            where: { id: row.id },
        });
        if (row.signature_state !== "COMPLETED") return page("waiting");
    }
    if (row.payment_state === "READY") return page("done");
    if (row.payment_state === "PENDING_VERIFICATION") return page("verifying");
    const now = deps.now();
    const existing = await openSetup(deps.db, row.id);
    if (sessionUsable(existing, now))
        return { status: 303, location: existing.checkout_url };
    const issued = await issuePaymentLink(deps, row.id, { mode: "continue" });
    if (issued.setup && sessionUsable(issued.setup, now))
        return { status: 303, location: issued.setup.checkout_url };
    return page(issued.skipped === "in_progress" ? "preparing" : "unavailable");
}
