// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { approvalEmail } from "./emails.js";
import { classifyLoad } from "./classify.js";
import { toCents, feeCents, describeLine, MIN_CHARGE_CENTS } from "./money.js";
import { runEndUtc } from "./schedule.js";
import { BillingInputError } from "./carriers.js";
import { SUPPORT_EMAIL, assertInvoiceMatches } from "./stripeClient.js";
export class StaleApprovalError extends BillingInputError {
    constructor() {
        super("stale_approval", 409);
    }
}
const fieldMap = {
    kelevoLoadId: "kelevo_load_id",
    loadNumber: "load_number",
    carrierId: "carrier_id",
    holdReason: "hold_reason",
    allInRateCents: "all_in_rate_cents",
    linehaulCents: "linehaul_cents",
    feeBp: "fee_bp",
    feeCents: "fee_cents",
    occurredAt: "occurred_at",
};
const rowOf = (decision, runId) =>
    Object.fromEntries(
        Object.entries({ ...decision, run_id: runId }).map(([k, v]) => [
            fieldMap[k] ?? k,
            v,
        ])
    );
const keyOf = (line) => `${line.kelevo_load_id}:${line.kind}`;
function summaryOf(runId, runEnd, lines, invoices, canceledWithoutDate) {
    return {
        runId,
        runEnd,
        invoices,
        held: lines
            .filter((l) => l.status === "held")
            .map((l) => ({
                lineId: l.id ?? null,
                kelevoLoadId: l.kelevo_load_id,
                reason: l.hold_reason,
                allInRateCents: l.all_in_rate_cents,
                enteredLinehaulCents: l.linehaul_cents,
            })),
        canceledWithoutDate,
        totalCents: invoices.reduce((sum, i) => sum + i.totalCents, 0),
    };
}
function groupLines(lines) {
    const groups = new Map();
    for (const l of lines) {
        if (!groups.has(l.carrier_id)) groups.set(l.carrier_id, []);
        groups.get(l.carrier_id).push(l);
    }
    return groups;
}
async function summaryStored(run, store, canceledWithoutDate = 0) {
    const lines = await store.listLinesForRun(run.id),
        invoices = await store.listInvoicesForRun(run.id);
    return summaryOf(
        run.id,
        run.run_end,
        lines,
        invoices.map((i) => ({
            carrierId: i.carrier_id,
            lineCount: lines.filter((l) => l.invoice_id === i.id).length,
            totalCents: i.total_cents,
        })),
        canceledWithoutDate
    );
}
async function sendSummary(run, summary, deps) {
    await deps.sendEmail({
        from: SUPPORT_EMAIL,
        to: deps.config.adminEmail,
        ...approvalEmail(
            summary,
            await deps.store.listCarriers(),
            deps.config.timezone
        ),
    });
    await deps.store.transitionRun(
        run.id,
        ["summary_pending"],
        "awaiting_approval"
    );
}
export async function startRun({ now, dryRun = false }, deps) {
    const execute = async () => {
        const { store, config, stripe } = deps;
        const end = runEndUtc(now, config.timezone);
        const existing = await store.getRunByEnd(end);
        if (existing?.status === "summary_pending") {
            const summary = await summaryStored(existing, store);
            if (!dryRun) await sendSummary(existing, summary, deps);
            return summary;
        }
        if (
            existing &&
            !["building", "awaiting_approval"].includes(existing.status)
        )
            return summaryStored(existing, store);
        const [loads, assets, carriers, known] = await Promise.all([
            deps.fetchLoads({ from: config.startDate, to: end }, config),
            store.listAssets(),
            store.listCarriers(),
            store.listAllLines(),
        ]);
        const ctx = {
            startDate: config.startDate,
            runEnd: end,
            carrierByDriver: new Map(),
            carrierByTruck: new Map(),
        };
        for (const a of assets) {
            const carrier = carriers.find(
                (c) => c.id === a.carrier_id && c.status !== "inactive"
            );
            if (carrier)
                (a.kind === "DRIVER"
                    ? ctx.carrierByDriver
                    : ctx.carrierByTruck
                ).set(a.kelevo_id, { id: carrier.id, feeBp: carrier.fee_bp });
        }
        const seen = new Set(known.map(keyOf)),
            newLines = [];
        for (const load of loads) {
            const occurred =
                load.status === "CANCELED"
                    ? load.canceledAt
                    : (load.deliveredAt ?? load.deliveryEnd);
            const current = {
                ...ctx,
                carrierByDriver: new Map(ctx.carrierByDriver),
                carrierByTruck: new Map(ctx.carrierByTruck),
            };
            for (const asset of assets)
                if (occurred && asset.effective_from > occurred)
                    (asset.kind === "DRIVER"
                        ? current.carrierByDriver
                        : current.carrierByTruck
                    ).delete(asset.kelevo_id);
            const decision = classifyLoad(load, current);
            if (decision) {
                const row = rowOf(decision, null);
                if (!seen.has(keyOf(row))) {
                    seen.add(keyOf(row));
                    newLines.push(row);
                }
            }
        }
        const canceledWithoutDate = loads.filter(
            (l) => l.status === "CANCELED" && !l.canceledAt
        ).length;
        const assigned = known.filter(
            (l) => l.invoice_id && l.run_id === existing?.id
        );
        const candidates = [
            ...(await store.listReadyLinesWithoutInvoice()),
            ...(await store.listMinimumLines()),
            ...newLines.filter((l) => l.status === "ready"),
            ...assigned,
        ];
        if (dryRun) {
            const invoices = [];
            const previewCandidates = candidates.map((l) => ({ ...l }));
            for (const [carrierId, lines] of groupLines(previewCandidates)) {
                const totalCents = lines.reduce((s, l) => s + l.fee_cents, 0);
                if (totalCents >= MIN_CHARGE_CENTS)
                    invoices.push({
                        carrierId,
                        lineCount: lines.length,
                        totalCents,
                    });
                else
                    for (const l of lines) {
                        l.status = "held";
                        l.hold_reason = "below_minimum";
                        const original = newLines.find(
                            (n) => keyOf(n) === keyOf(l)
                        );
                        if (original) {
                            original.status = "held";
                            original.hold_reason = "below_minimum";
                        }
                    }
            }
            return summaryOf(
                null,
                end,
                [
                    ...new Map(
                        [
                            ...known.filter(
                                (l) =>
                                    l.run_id === existing?.id &&
                                    l.status === "held" &&
                                    l.hold_reason !== "below_minimum"
                            ),
                            ...newLines,
                            ...previewCandidates.filter(
                                (l) => l.status === "held"
                            ),
                        ].map((l) => [keyOf(l), l])
                    ).values(),
                ],
                invoices,
                canceledWithoutDate
            );
        }
        const { run } = await store.claimRun(end);
        if (
            !(await store.transitionRun(
                run.id,
                ["building", "awaiting_approval"],
                "building"
            ))
        )
            throw new BillingInputError("billing_busy", 409);
        await store.insertLinesIfAbsent(
            newLines.map((l) => ({ ...l, run_id: run.id }))
        );
        await store.withTransaction(async () => {
            const ready = [
                ...(await store.listReadyLinesWithoutInvoice()),
                ...(await store.listMinimumLines()),
                ...(await store.listLinesForRun(run.id)).filter(
                    (l) => l.invoice_id
                ),
            ];
            for (const [carrierId, lines] of groupLines(ready)) {
                const total = lines.reduce((s, l) => s + l.fee_cents, 0);
                if (total < MIN_CHARGE_CENTS) {
                    for (const l of lines)
                        await store.updateLineIf(l.id, ["ready", "held"], {
                            status: "held",
                            hold_reason: "below_minimum",
                            run_id: run.id,
                        });
                    continue;
                }
                const invoice = await store.createInvoiceRow({
                    run_id: run.id,
                    carrier_id: carrierId,
                    total_cents: total,
                });
                for (const l of lines)
                    await store.updateLineIf(l.id, ["ready", "held"], {
                        status: "invoiced",
                        hold_reason: null,
                        run_id: run.id,
                        invoice_id: invoice.id,
                    });
                await store.transitionInvoice(invoice.id, ["draft"], "draft", {
                    total_cents: total,
                });
            }
        });
        // Intents and line membership are durable before any Stripe write.
        for (const invoice of await store.listInvoicesForRun(run.id)) {
            const carrier = await store.getCarrier(invoice.carrier_id);
            if (!carrier.stripe_customer_id)
                throw new BillingInputError("carrier_setup_required", 409);
            const remote = await stripe.listInvoicesForRun(
                carrier.stripe_customer_id,
                run.id
            );
            if (remote.length > 1)
                throw new BillingInputError("duplicate_remote_invoice", 409);
            let draft = remote[0];
            if (!draft) {
                if (invoice.stripe_invoice_id)
                    throw new BillingInputError("remote_invoice_missing", 409);
                const { invoiceId } = await stripe.createDraftInvoice({
                    customerId: carrier.stripe_customer_id,
                    runId: run.id,
                    carrierId: carrier.id,
                });
                draft = { id: invoiceId, status: "draft", itemLineIds: [] };
            }
            if (draft.status !== "draft")
                throw new BillingInputError("remote_invoice_not_draft", 409);
            await store.transitionInvoice(invoice.id, ["draft"], "draft", {
                stripe_invoice_id: draft.id,
            });
            const lines = (await store.listLinesForRun(run.id)).filter(
                (l) => l.invoice_id === invoice.id
            );
            if (
                new Set(draft.itemLineIds).size !== draft.itemLineIds.length ||
                draft.itemLineIds.some((id) => !lines.some((l) => l.id === id))
            )
                throw new BillingInputError("remote_items_mismatch", 409);
            for (const l of lines) {
                if (draft.itemLineIds.includes(l.id)) continue;
                if (l.stripe_invoice_item_id)
                    throw new BillingInputError("remote_item_missing", 409);
                const description = describeLine(
                    {
                        kind: l.kind,
                        loadNumber: l.load_number,
                        kelevoLoadId: l.kelevo_load_id,
                        occurredAt: l.occurred_at,
                        linehaulCents: l.linehaul_cents,
                        feeBp: l.fee_bp,
                        feeCents: l.fee_cents,
                    },
                    config.timezone
                );
                const { itemId } = await stripe.addInvoiceItem({
                    customerId: carrier.stripe_customer_id,
                    invoiceId: draft.id,
                    lineId: l.id,
                    amountCents: l.fee_cents,
                    description,
                });
                await store.updateLineIf(l.id, ["invoiced"], {
                    stripe_invoice_item_id: itemId,
                });
            }
            assertInvoiceMatches(await stripe.retrieveInvoice(draft.id), {
                totalCents: invoice.total_cents,
                customerId: carrier.stripe_customer_id,
                runId: run.id,
                carrierId: carrier.id,
                lineFees: lines,
            });
        }
        await store.transitionRun(run.id, ["building"], "summary_pending");
        const summary = await summaryStored(run, store, canceledWithoutDate);
        await sendSummary(run, summary, deps);
        return summary;
    };
    return dryRun ? execute() : deps.store.withBillingLock(execute);
}
export async function setLinehaul(id, amount, note, deps) {
    return deps.store.withBillingLock(async () => {
        let cents;
        try {
            cents = toCents(amount);
        } catch {
            throw new BillingInputError("invalid_linehaul");
        }
        if (
            !cents ||
            cents > 2147483647 ||
            typeof note !== "string" ||
            !note.trim() ||
            note.length > 500 ||
            [...note].some((c) => c.charCodeAt(0) < 32)
        )
            throw new BillingInputError("invalid_linehaul");
        const line = await deps.store.getLine(id);
        if (
            !line ||
            line.invoice_id ||
            !["held", "ready"].includes(line.status)
        )
            throw new BillingInputError("line_not_editable", 409);
        const allowed = ["needs_linehaul", "below_minimum", null];
        const reason = allowed.includes(line.hold_reason)
            ? null
            : line.hold_reason;
        await deps.store.updateLineIf(id, ["held", "ready"], {
            linehaul_cents: cents,
            linehaul_note: note.trim(),
            fee_cents: line.fee_bp ? feeCents(cents, line.fee_bp) : null,
            status: reason ? "held" : "ready",
            hold_reason: reason,
        });
    });
}
export async function decideCancelled(id, charge, deps) {
    return deps.store.withBillingLock(async () => {
        const line = await deps.store.getLine(id);
        if (
            typeof charge !== "boolean" ||
            !line ||
            line.kind !== "CARRIER_CANCELLED" ||
            line.invoice_id ||
            line.status !== "held" ||
            !["cancelled_by_whom", "needs_linehaul"].includes(line.hold_reason)
        )
            throw new BillingInputError("invalid_decision", 409);
        const reason =
            charge && !(line.linehaul_cents > 0) ? "needs_linehaul" : null;
        await deps.store.updateLineIf(id, ["held"], {
            status: !charge ? "skipped" : reason ? "held" : "ready",
            hold_reason: reason,
        });
    });
}
export async function approveRun(id, expected, approver, deps) {
    return deps.store.withBillingLock(async () => {
        const run = await deps.store.getRun(id),
            invoices = await deps.store.listInvoicesForRun(id);
        const total = invoices.reduce((s, i) => s + i.total_cents, 0);
        const lines = await deps.store.listLinesForRun(id);
        if (
            lines.some((l) => l.status === "ready" && !l.invoice_id) ||
            invoices.some(
                (i) =>
                    lines
                        .filter((l) => l.invoice_id === i.id)
                        .reduce((s, l) => s + l.fee_cents, 0) !== i.total_cents
            )
        )
            throw new StaleApprovalError();
        if (
            !run ||
            run.status !== "awaiting_approval" ||
            expected.invoiceCount !== invoices.length ||
            expected.totalCents !== total
        )
            throw new StaleApprovalError();
        if (
            !(await deps.store.transitionRun(
                id,
                ["awaiting_approval"],
                "approved",
                {
                    approved_by: approver,
                    approved_at: new Date(),
                    approved_invoice_count: invoices.length,
                    approved_total_cents: total,
                }
            ))
        )
            throw new StaleApprovalError();
    });
}
