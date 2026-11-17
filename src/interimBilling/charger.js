// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { nextStep } from "./retryPolicy.js";
import { BillingInputError } from "./carriers.js";
import { SUPPORT_EMAIL } from "./stripeClient.js";
const clock = (deps) => deps.now?.() ?? new Date();
async function alertFailure(invoice, carrier, deps, code) {
    await deps.sendEmail({
        from: SUPPORT_EMAIL,
        to: deps.config.adminEmail,
        subject: `Dispatch invoice ${invoice.id}: ${code}`,
        text: `Invoice ${invoice.id}: ${code}. Review before pausing new bookings.`,
    });
    if (code === "payment_failed")
        await deps.emailClient(
            carrier.email,
            "Dispatch payment unsuccessful",
            `Payment for your dispatch statement remains unpaid. Please contact ${SUPPORT_EMAIL}. Statement: ${invoice.hosted_invoice_url ?? "contact dispatch"}`
        );
}
// Internal entry point; caller holds the module's database session lock.
export async function applyPayOutcomeLocked(id, outcome, now, deps) {
    const { store } = deps,
        invoice = await store.getInvoice(id);
    if (!invoice) return;
    // Paid/failed are terminal to automated collection. Late returns alert only.
    if (invoice.status === "paid" && outcome.outcome !== "paid") {
        if (outcome.outcome === "failed")
            await alertFailure(
                invoice,
                await store.getCarrier(invoice.carrier_id),
                deps,
                "late_return"
            );
        return;
    }
    if (invoice.status === "failed") return;
    const common = {
        payment_intent_id:
            outcome.paymentIntentId ?? invoice.payment_intent_id ?? null,
        next_attempt_at: null,
        last_error_code: outcome.errorCode ?? null,
    };
    if (outcome.outcome === "paid") {
        await store.transitionInvoice(id, [invoice.status], "paid", common);
        await store.updateInvoiceLines(id, "paid");
        return;
    }
    if (outcome.outcome === "processing") {
        await store.transitionInvoice(
            id,
            [invoice.status],
            "processing",
            common
        );
        return;
    }
    if (!["paying", "processing"].includes(invoice.status)) return;
    const carrier = await store.getCarrier(invoice.carrier_id),
        firstFailureAt = invoice.first_failure_at ?? now;
    const next = nextStep(
        {
            round: invoice.round,
            triedBackupThisRound: invoice.tried_backup_this_round,
            hasBackup: !!carrier.backup_pm_id,
            firstFailureAt,
        },
        now,
        deps.config.timezone
    );
    if (next.action === "give_up") {
        await store.transitionInvoice(id, [invoice.status], "failed", {
            ...common,
            first_failure_at: firstFailureAt,
        });
        await store.updateInvoiceLines(id, "failed");
        await alertFailure(invoice, carrier, deps, "payment_failed");
        return;
    }
    await store.transitionInvoice(id, [invoice.status], "retry_scheduled", {
        ...common,
        first_failure_at: firstFailureAt,
        round: next.round,
        next_method: next.method,
        next_attempt_at: next.at,
        tried_backup_this_round: false,
    });
    if (next.at <= now && !deps.deferImmediateRetry)
        await attempt(id, next.method, now, deps);
}
export async function applyPayOutcome(id, outcome, now, deps) {
    return deps.store.withBillingLock(() =>
        applyPayOutcomeLocked(id, outcome, now, deps)
    );
}
async function attempt(id, method, now, deps) {
    const { store, stripe } = deps;
    let invoice = await store.getInvoice(id);
    const carrier = await store.getCarrier(invoice.carrier_id);
    if (!carrier.primary_pm_id) {
        await alertFailure(invoice, carrier, deps, "primary_method_missing");
        return;
    }
    const pm =
        method === "backup" ? carrier.backup_pm_id : carrier.primary_pm_id;
    // Persist attempt identity BEFORE payment. Recovery reuses it on uncertainty.
    if (
        !(await store.transitionInvoice(
            id,
            ["finalizing", "retry_scheduled"],
            "paying",
            {
                current_pm_id: pm,
                attempts: invoice.attempts + 1,
                tried_backup_this_round: method === "backup",
                next_attempt_at: null,
            }
        ))
    )
        return;
    invoice = await store.getInvoice(id);
    const result = await stripe.payInvoice(
        invoice.stripe_invoice_id,
        pm,
        `attempt-${invoice.attempts}`
    );
    await applyPayOutcomeLocked(id, result, now, deps);
}
async function recoverPaying(invoice, now, deps) {
    const remote = await deps.stripe.retrieveInvoice(invoice.stripe_invoice_id);
    if (
        remote.status === "paid" ||
        remote.paymentIntent?.status === "processing"
    ) {
        await applyPayOutcomeLocked(
            invoice.id,
            {
                outcome: remote.status === "paid" ? "paid" : "processing",
                paymentIntentId: remote.paymentIntent?.id,
            },
            now,
            deps
        );
        return;
    }
    const result = await deps.stripe.payInvoice(
        invoice.stripe_invoice_id,
        invoice.current_pm_id,
        `attempt-${invoice.attempts}`
    );
    await applyPayOutcomeLocked(invoice.id, result, now, deps);
}
export async function chargeApprovedRun(id, deps) {
    return deps.store.withBillingLock(async () => {
        const { store, stripe } = deps,
            run = await store.getRun(id),
            now = clock(deps);
        if (!run || !["approved", "charging"].includes(run.status)) return;
        const invoices = await store.listInvoicesForRun(id);
        if (
            run.approved_invoice_count !== invoices.length ||
            run.approved_total_cents !==
                invoices.reduce((s, i) => s + i.total_cents, 0)
        )
            throw new BillingInputError("approval_mismatch", 409);
        if (
            !(await store.transitionRun(
                id,
                ["approved", "charging"],
                "charging"
            ))
        )
            return;
        for (const row of invoices) {
            let invoice = await store.getInvoice(row.id);
            const carrier = await store.getCarrier(invoice.carrier_id);
            if (!carrier.primary_pm_id) {
                await alertFailure(
                    invoice,
                    carrier,
                    deps,
                    "primary_method_missing"
                );
                continue;
            }
            if (invoice.status === "draft") {
                if (
                    !(await store.transitionInvoice(
                        invoice.id,
                        ["draft"],
                        "finalizing"
                    ))
                )
                    continue;
                invoice = await store.getInvoice(invoice.id);
            }
            if (invoice.status === "finalizing") {
                const statement = await stripe.finalizeInvoice(
                    invoice.stripe_invoice_id
                );
                await store.transitionInvoice(
                    invoice.id,
                    ["finalizing"],
                    "finalizing",
                    { hosted_invoice_url: statement.hostedInvoiceUrl }
                );
                await deps.emailClient(
                    carrier.email,
                    "Your weekly dispatch statement",
                    `Your itemised statement: ${statement.hostedInvoiceUrl}\nPDF: ${statement.invoicePdf}\nQuestions within 14 days: ${SUPPORT_EMAIL}. We will charge your primary payment method.`
                );
                await attempt(invoice.id, "primary", now, deps);
            } else if (invoice.status === "paying")
                await recoverPaying(invoice, now, deps);
        }
        const remaining = await store.listInvoicesForRun(id);
        if (
            !remaining.some((i) =>
                ["draft", "finalizing", "paying"].includes(i.status)
            )
        )
            await store.transitionRun(id, ["charging"], "done");
    });
}
export async function runDueRetries(now, deps) {
    return deps.store.withBillingLock(async () => {
        const due = await deps.store.listDueRetries(now);
        let count = 0;
        for (const invoice of due) {
            await attempt(invoice.id, invoice.next_method, now, deps);
            count++;
        }
        // A crash during a retry leaves a paying invoice on a run already done.
        if (deps.store.listPayingInvoices)
            for (const invoice of await deps.store.listPayingInvoices())
                await recoverPaying(invoice, now, deps);
        return count;
    });
}
