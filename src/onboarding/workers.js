import { portalReminderIds, sendDuePortalReminder } from "./portalFlow.js";
import { readPendingDocuments } from "./reader/worker.js";
import { purgeDue, retentionDay } from "./retention.js";
import { addLoadBoardItem } from "./loadBoardBackfill.js";
import { readyAfterRuleChange } from "./readyBackfill.js";
import { deliverPending } from "./outbox.js";
import { REPLAY_RECEIPT_TTL_MS, pruneReplayReceipts } from "./store.js";
import {
    openEnvelopeIds,
    reconcileEnvelope,
    reconcileSignature,
} from "./signatureFlow.js";
import { openPaymentRequestIds, reconcilePayment } from "./paymentFlow.js";
import { reminderCandidateIds, sendDueReminder } from "./documentsFlow.js";
import {
    recoverRequestSteps,
    stalledRequestIds,
    unsentRequestIds,
} from "./recovery.js";

/**
 * One reconcile pass: open envelopes, unsent packets, pending payments,
 * crash recovery of after-commit steps (payment link, completion email,
 * provisioning) and the R15 documents reminders.
 */
export async function reconcileOnce(deps) {
    const log = (code) => deps.logger?.error?.({ code });
    await pruneReplayReceipts(
        deps.db,
        new Date(deps.now().getTime() - REPLAY_RECEIPT_TTL_MS)
    ).catch(() => log("onboarding_replay_prune_failed"));
    await reconcileEnvelopesOnce(deps);
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
    // R15 documents reminders (this worker pass only, never the action).
    for (const id of await reminderCandidateIds(deps))
        await sendDueReminder(deps, id).catch(() =>
            log("onboarding_reconcile_reminder_failed")
        );
    for (const id of await portalReminderIds(deps))
        await sendDuePortalReminder(deps, id).catch(() =>
            log("onboarding_portal_reminder_failed")
        );
}

/** Re-reads every open signature packet from the provider. */
export async function reconcileEnvelopesOnce(deps) {
    for (const id of await openEnvelopeIds(deps.db, deps.now().getTime()))
        await reconcileEnvelope(deps, id).catch(() =>
            deps.logger?.error?.({
                code: "onboarding_reconcile_envelope_failed",
            })
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
    if (config.reconcile?.enabled && config.reconcile.envelopeIntervalMs)
        timers.push(
            every(
                config.reconcile.envelopeIntervalMs,
                guard("onboarding_reconcile_failed", () =>
                    reconcileEnvelopesOnce(deps)
                )
            )
        );
    if (config.reader?.enabled)
        timers.push(
            every(
                config.reconcile?.intervalMs ?? 60000,
                guard("onboarding_reader_failed", () =>
                    readPendingDocuments(deps)
                )
            )
        );
    // Once per start: requests in progress get the load board checklist item.
    addLoadBoardItem(deps.db, deps.now()).catch(() =>
        deps.logger?.error?.({ code: "onboarding_load_board_backfill_failed" })
    );
    // Once per start: requests that are READY under the current rule (factoring
    // optional on the portal, Kelevo set-up not required; owner rulings
    // 2026-11-19) get their READY side effects.
    readyAfterRuleChange(deps.db, deps.now()).catch(() =>
        deps.logger?.error?.({ code: "onboarding_ready_backfill_failed" })
    );
    // Retention applies to every onboarding request, with or without the
    // portal switch (owner ruling: 90 days abandoned, 3 years completed).
    let lastPurgeDay;
    timers.push(
        every(
            60000,
            guard("onboarding_retention_failed", async () => {
                const now = deps.now();
                const day = retentionDay(now);
                if (day && day !== lastPurgeDay) {
                    await purgeDue(deps, now);
                    lastPurgeDay = day;
                }
            })
        )
    );
    deps.logger?.info?.({
        code: "onboarding_workers_started",
        outbox: !!config.outbox?.enabled,
        reconcile: !!config.reconcile?.enabled,
    });
    return { stop: () => timers.forEach(clearInterval), count: timers.length };
}
