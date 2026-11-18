import { deliverPending } from "./outbox.js";
import { REPLAY_RECEIPT_TTL_MS, pruneReplayReceipts } from "./store.js";
import {
    openEnvelopeIds,
    reconcileEnvelope,
    reconcileSignature,
} from "./signatureFlow.js";
import { openPaymentRequestIds, reconcilePayment } from "./paymentFlow.js";
import {
    recoverRequestSteps,
    stalledRequestIds,
    unsentRequestIds,
} from "./recovery.js";

/**
 * One reconcile pass: open envelopes, unsent packets, pending payments and
 * crash recovery of after-commit steps (payment link, provisioning).
 */
export async function reconcileOnce(deps) {
    const log = (code) => deps.logger?.error?.({ code });
    await pruneReplayReceipts(
        deps.db,
        new Date(deps.now().getTime() - REPLAY_RECEIPT_TTL_MS)
    ).catch(() => log("onboarding_replay_prune_failed"));
    for (const id of await openEnvelopeIds(deps.db, deps.now().getTime()))
        await reconcileEnvelope(deps, id).catch(() =>
            log("onboarding_reconcile_envelope_failed")
        );
    for (const id of await unsentRequestIds(deps))
        await reconcileSignature(deps, id).catch(() =>
            log("onboarding_reconcile_send_failed")
        );
    for (const id of await openPaymentRequestIds(deps.db))
        await reconcilePayment(deps, id).catch(() =>
            log("onboarding_reconcile_payment_failed")
        );
    for (const id of await stalledRequestIds(deps))
        await recoverRequestSteps(deps, id).catch(() =>
            log("onboarding_reconcile_recovery_failed")
        );
}

function every(ms, fn) {
    let running = false;
    const timer = setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await fn();
        } finally {
            running = false;
        }
    }, ms);
    timer.unref?.();
    return timer;
}

/**
 * Starts background work only when ONBOARDING_ENABLED=1 and the specific
 * switch/configuration is present. Returns { stop } or null.
 */
export function startOnboardingWorkers(deps) {
    const { config } = deps;
    if (!config?.enabled) return null;
    const timers = [];
    const guard = (code, fn) => () =>
        fn().catch(() => deps.logger?.error?.({ code }));
    if (config.outbox?.enabled)
        timers.push(
            every(
                config.outbox.intervalMs,
                guard("onboarding_outbox_failed", () => deliverPending(deps))
            )
        );
    if (config.reconcile?.enabled)
        timers.push(
            every(
                config.reconcile.intervalMs,
                guard("onboarding_reconcile_failed", () => reconcileOnce(deps))
            )
        );
    deps.logger?.info?.({
        code: "onboarding_workers_started",
        outbox: !!config.outbox?.enabled,
        reconcile: !!config.reconcile?.enabled,
    });
    return { stop: () => timers.forEach(clearInterval), count: timers.length };
}
