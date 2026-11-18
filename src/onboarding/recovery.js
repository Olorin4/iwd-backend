import { sendPortalInvitation } from "./portalFlow.js";
import { transition } from "./store.js";
import { issuePaymentLink } from "./paymentFlow.js";
import { startProvisioning } from "./provisioningFlow.js";
import { sendCompletionEmail } from "./documentsFlow.js";

// Crash recovery. Each step of the lifecycle is started by an after-commit
// task (deps.schedule); a process stop between the commit and that task leaves
// a request waiting for a step nothing will start. These sweeps restart them.
export const STALE_STEP_MS = 10 * 60 * 1000;

const cutoff = (deps) => new Date(deps.now().getTime() - STALE_STEP_MS);

/** A PENDING provisioning older than 10 min is failed so it can be retried. */
export async function failStaleProvisioning(deps, requestId) {
    const before = cutoff(deps);
    const result = await transition(deps.db, requestId, (row) =>
        row.provisioning_state === "PENDING" &&
        row.provisioning_at &&
        row.provisioning_at < before
            ? {
                  provisioning_state: "FAILED",
                  provisioning_code: "provisioning_stale",
                  provisioning_at: deps.now(),
              }
            : null
    );
    if (result.changed)
        deps.logger?.error?.({ code: "onboarding_provisioning_stale" });
    return result.changed;
}

/**
 * A PaymentSetup stuck in CREATING (process stopped during the Stripe call)
 * for more than 10 min is FAILED `payment_setup_stale`, and so is the payment
 * facet unless payment already progressed; resend_payment_link then works.
 */
export async function failStalePaymentSetups(deps, requestId) {
    const { count } = await deps.db.paymentSetup.updateMany({
        where: {
            request_id: requestId,
            state: "CREATING",
            created_at: { lt: cutoff(deps) },
        },
        data: { state: "FAILED", last_error_code: "payment_setup_stale" },
    });
    if (count === 0) return false;
    deps.logger?.error?.({ code: "onboarding_payment_setup_stale" });
    await transition(deps.db, requestId, (row) =>
        ["NOT_STARTED", "LINK_SENT", "FAILED"].includes(row.payment_state)
            ? {
                  payment_state: "FAILED",
                  payment_code: "payment_setup_stale",
                  payment_at: deps.now(),
              }
            : null
    );
    return true;
}

/**
 * Restarts the steps after signature and payment for one request:
 * (0) PaymentSetup CREATING > 10 min → FAILED `payment_setup_stale`;
 * (a) signature COMPLETED + payment NOT_STARTED → initial payment link, and
 *     signature COMPLETED + combined email not sent → that email (R15; sent
 *     whatever the payment state, e.g. already READY);
 * (c) stale PENDING provisioning → FAILED `provisioning_stale`;
 * (b) payment READY + provisioning NOT_STARTED → start provisioning.
 * Every step re-checks its own preconditions under the request lock.
 */
export async function recoverRequestSteps(deps, requestId) {
    let row = await deps.db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (!row || row.purged_at) return;
    if (row.portal_flow && !row.portal_invited_at)
        await sendPortalInvitation(deps, requestId);
    if (await failStalePaymentSetups(deps, requestId))
        row = await deps.db.onboardingRequest.findUnique({
            where: { id: requestId },
        });
    if (
        !row.portal_flow &&
        !row.cancelled_at &&
        row.signature_state === "COMPLETED" &&
        row.payment_state === "NOT_STARTED"
    )
        await issuePaymentLink(deps, requestId, { mode: "initial" });
    // R15: the combined completion email whatever the payment state (the
    // carrier may already have saved a method); claimed once per request.
    if (
        !row.portal_flow &&
        !row.cancelled_at &&
        row.signature_state === "COMPLETED" &&
        !row.completion_emailed_at &&
        !row.completion_email_code
    )
        await sendCompletionEmail(deps, requestId);
    if (row.provisioning_state === "PENDING")
        await failStaleProvisioning(deps, requestId);
    row = await deps.db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (
        !row.cancelled_at &&
        row.payment_state === "READY" &&
        row.provisioning_state === "NOT_STARTED"
    )
        await startProvisioning(deps, requestId);
}

/** Request ids that need one of the recoveries above (reconcile worker). */
export async function stalledRequestIds(deps) {
    const rows = await deps.db.onboardingRequest.findMany({
        where: {
            OR: [
                {
                    portal_flow: true,
                    cancelled_at: null,
                    purged_at: null,
                    portal_invited_at: null,
                    portal_invite_attempts: { lt: 3 },
                    OR: [
                        { signature_waiting_for: "CARRIER" },
                        { signature_state: "COMPLETED" },
                    ],
                },
                {
                    portal_flow: false,
                    cancelled_at: null,
                    signature_state: "COMPLETED",
                    payment_state: "NOT_STARTED",
                },
                {
                    portal_flow: false,
                    cancelled_at: null,
                    signature_state: "COMPLETED",
                    completion_emailed_at: null,
                    completion_email_code: null,
                },
                {
                    cancelled_at: null,
                    payment_state: "READY",
                    provisioning_state: "NOT_STARTED",
                },
                {
                    provisioning_state: "PENDING",
                    provisioning_at: { lt: cutoff(deps) },
                },
            ],
        },
        select: { id: true },
        take: 200,
    });
    const stuck = await deps.db.paymentSetup.findMany({
        where: { state: "CREATING", created_at: { lt: cutoff(deps) } },
        select: { request_id: true },
        take: 200,
    });
    return [
        ...new Set([
            ...rows.map((r) => r.id),
            ...stuck.map((s) => s.request_id),
        ]),
    ];
}

/**
 * Unsent packets: NOT_SENT with a recorded code (e.g. bundle_unavailable), or
 * any NOT_SENT request older than 10 min (the after-commit send never ran).
 */
export async function unsentRequestIds(deps) {
    const rows = await deps.db.onboardingRequest.findMany({
        where: {
            cancelled_at: null,
            signature_state: "NOT_SENT",
            OR: [
                { signature_code: { not: null } },
                { created_at: { lt: cutoff(deps) } },
            ],
        },
        select: { id: true },
        take: 100,
    });
    return rows.map((r) => r.id);
}
