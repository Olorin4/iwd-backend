// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { formatUsd } from "./money.js";
import { SUPPORT_EMAIL } from "./stripeClient.js";

const singleLine = (value) => String(value).replace(/\s+/g, " ").trim();
const holdReasons = {
    needs_linehaul:
        "Missing linehaul — enter the linehaul amount excluding fuel and extras.",
    cancelled_by_whom:
        "Cancellation needs review — confirm whether the carrier cancelled after accepting.",
    no_carrier:
        "Carrier not assigned — review the driver/truck mapping and its effective date.",
    carrier_conflict:
        "Carrier mapping conflict — resolve the conflicting driver and truck assignments.",
    non_usd: "Non-USD load — review the source currency before billing.",
    below_minimum:
        "Below the $0.50 minimum — carried forward until the minimum is reached.",
};

export function approvalEmail(summary, carriers, timezone = "America/Chicago") {
    const weekEnd = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeZone: timezone,
    }).format(new Date(+new Date(summary.runEnd) - 1));
    const names = new Map(
        carriers.map((c) => [c.id, singleLine(c.legal_name)])
    );
    const invoices = summary.invoices.map(
        (i) =>
            `- ${names.get(i.carrierId) || `Carrier ${i.carrierId}`} (carrier ${i.carrierId}): ${i.lineCount} ${i.lineCount === 1 ? "load" : "loads"}, ${formatUsd(i.totalCents)} USD`
    );
    const held = summary.held.map((l) => {
        const context = [
            l.allInRateCents != null
                ? `All-in rate (reference only): ${formatUsd(l.allInRateCents)}.`
                : null,
            l.enteredLinehaulCents != null
                ? `Entered linehaul: ${formatUsd(l.enteredLinehaulCents)}.`
                : null,
        ]
            .filter(Boolean)
            .join(" ");
        return `- Load ID ${l.kelevoLoadId}${l.lineId ? ` (line ${l.lineId})` : ""}: ${holdReasons[l.reason] ?? "Needs operator review."}${context ? `\n  ${context}` : ""}`;
    });
    return {
        subject: `Action required: approve dispatch billing run ${summary.runId}`,
        text: [
            "ADMIN ONLY — dispatch billing approval",
            `Run: ${summary.runId}`,
            `Week ending: ${weekEnd} (${timezone})`,
            "Earlier unbilled loads may also be included.",
            "",
            `Invoices: ${summary.invoices.length}`,
            `Total to approve: ${formatUsd(summary.totalCents)} USD`,
            "No payment is started for this run until you approve it.",
            "",
            "CARRIER TOTALS",
            ...(invoices.length ? invoices : ["No invoices ready to charge."]),
            "",
            `HELD LOADS: ${held.length}`,
            ...(held.length ? held : ["None."]),
            `Undated cancellations excluded: ${summary.canceledWithoutDate}`,
            "Undated cancellations cannot be billed; review and correct the source date first.",
            "",
            "NEXT STEPS",
            "Review the run and held loads through the billing admin API. Enter missing linehaul and decide who cancelled each cancelled load. Refresh the draft after changes and review the new summary.",
            `When the totals match your review, approve run ${summary.runId} with invoice count ${summary.invoices.length} and total ${summary.totalCents} cents (${formatUsd(summary.totalCents)} USD). Use the latest summary; an older total will be rejected.`,
            "Fees apply to linehaul only, excluding fuel surcharge and accessorials.",
        ].join("\n"),
    };
}

export function statementEmail(invoice, statement) {
    return {
        subject: "Your weekly dispatch statement",
        text: [
            "Your Iron Wing Dispatching statement is ready.",
            `Dispatch fees: ${formatUsd(invoice.total_cents)} USD`,
            "",
            `View your itemized statement: ${statement.hostedInvoiceUrl}`,
            `Download the invoice PDF: ${statement.invoicePdf}`,
            "",
            "We will charge your saved primary payment method. If it is declined or returned, we may use your saved backup. This email is a statement, not confirmation of payment; bank debits may take time to process.",
            "Fees apply only to linehaul and are owed regardless of factoring or broker payment.",
            `Questions or corrections? Contact ${SUPPORT_EMAIL} within 14 days of this statement.`,
        ].join("\n"),
    };
}

export function failureEmail(invoice, code) {
    const late = code === "late_return";
    return {
        subject: late
            ? `Billing alert: returned payment for dispatch invoice ${invoice.id}`
            : `Action required: dispatch invoice ${invoice.id} remains unpaid`,
        text: [
            "ADMIN ONLY — payment review required",
            `Invoice: ${invoice.id} | Carrier: ${invoice.carrier_id}`,
            `Dispatch fees: ${formatUsd(invoice.total_cents)} USD`,
            late
                ? "Stripe reports a payment failure after this invoice was marked paid. No further automatic collection will be attempted. Review the payment in Stripe before taking action."
                : "The configured payment attempts are exhausted. No further automatic collection will be attempted. Contact the carrier to resolve payment; review before deciding whether to pause new bookings.",
            `Statement: ${invoice.hosted_invoice_url ?? "Review the invoice in Stripe."}`,
        ].join("\n"),
    };
}

export function unsuccessfulEmail(invoice) {
    return {
        subject: "Dispatch payment unsuccessful",
        text: [
            `Payment for your dispatch statement of ${formatUsd(invoice.total_cents)} USD remains unsuccessful after our scheduled attempts.`,
            "No further automatic payment attempt is scheduled for this statement.",
            `Please contact ${SUPPORT_EMAIL} to arrange payment. New bookings may be paused until payment is resolved.`,
            `View your statement: ${invoice.hosted_invoice_url ?? "Contact dispatch for your statement."}`,
        ].join("\n\n"),
    };
}

export function disputeEmail(disputeId) {
    return {
        subject: "Billing alert: dispatch payment disputed",
        text: `ADMIN ONLY — a dispatch payment has been disputed.\n\nDispute reference: ${disputeId}\nReview the dispute and response deadline in Stripe. No automatic retry is triggered by this dispute.`,
    };
}

export function setupEmail(role, url) {
    return {
        subject: "Set up dispatch fee payments",
        text: `Save your ${role} payment method securely with Stripe:\n${url}\n\nNothing is charged during setup. Your payment details are collected by Stripe. ${role === "backup" ? "Your backup is used only if your primary payment is declined or returned." : "This is the first payment method we will use for your weekly dispatch fees."}\n\nIf you choose a bank account, complete any bank verification requested by Stripe. Setup is complete only after Stripe confirms verification.\n\nQuestions? Contact ${SUPPORT_EMAIL}.`,
    };
}
