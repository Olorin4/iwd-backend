import { deliverPending } from "./outbox.js";
import {
    openEnvelopeIds,
    reconcileEnvelope,
    sendPacket,
} from "./signatureFlow.js";
import { openPaymentRequestIds, reconcilePayment } from "./paymentFlow.js";

/** One reconcile pass: open envelopes, unsent packets and pending payments. */
export async function reconcileOnce(deps) {
    const log = (code) => deps.logger?.error?.({ code });
    for (const id of await openEnvelopeIds(deps.db, deps.now().getTime()))
        await reconcileEnvelope(deps, id).catch(() =>
            log("onboarding_reconcile_envelope_failed")
        );
    const unsent = await deps.db.onboardingRequest.findMany({
        where: {
            cancelled_at: null,
            signature_state: "NOT_SENT",
            signature_code: { not: null },
        },
        select: { id: true },
        take: 100,
    });
    for (const { id } of unsent)
        await sendPacket(deps, id).catch(() =>
            log("onboarding_reconcile_send_failed")
        );
    for (const id of await openPaymentRequestIds(deps.db))
        await reconcilePayment(deps, id).catch(() =>
            log("onboarding_reconcile_payment_failed")
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
