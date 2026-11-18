import { transition } from "./store.js";
import { issuePaymentLink } from "./paymentFlow.js";
import { startProvisioning } from "./provisioningFlow.js";

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
 * Restarts the steps after signature and payment for one request:
 * (a) signature COMPLETED + payment NOT_STARTED → initial payment link;
 * (c) stale PENDING provisioning → FAILED `provisioning_stale`;
 * (b) payment READY + provisioning NOT_STARTED → start provisioning.
 * Every step re-checks its own preconditions under the request lock.
 */
export async function recoverRequestSteps(deps, requestId) {
    let row = await deps.db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    if (!row) return;
    if (
        !row.cancelled_at &&
        row.signature_state === "COMPLETED" &&
        row.payment_state === "NOT_STARTED"
    )
        await issuePaymentLink(deps, requestId, { mode: "initial" });
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
                    cancelled_at: null,
                    signature_state: "COMPLETED",
                    payment_state: "NOT_STARTED",
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
    return rows.map((r) => r.id);
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
