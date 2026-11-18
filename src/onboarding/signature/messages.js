// Plain-text SignWell email copy for the onboarding packet (owner ruling
// 2026-11-18). Values come only from the confirmed terms; no provider ids,
// secrets or JSON ever appear in the text.

export const REQUESTER_NAME = "Iron Wing Logistics L.L.C.";

const PLAN_LABELS = {
    ESSENTIAL: "Essential",
    FULL_SERVICE: "Full-Service",
    FLEET: "Fleet",
};

/** One line of plain text: no braces, no control characters, bounded. */
export function plain(value, max) {
    const text = String(value ?? "")
        .replace(/[{}]/g, "")
        // eslint-disable-next-line no-control-regex -- strip control characters
        .replace(/[\u0000-\u001f\u007f]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const effectiveDate = (ymd) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

const feePercent = (bp) => `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

export function planLabel(terms) {
    if (terms.plan === "FLEET" && terms.fleet_service_plan)
        return `Fleet ${PLAN_LABELS[terms.fleet_service_plan]}`;
    return PLAN_LABELS[terms.plan] ?? plain(terms.plan, 30);
}

/**
 * Document name plus per-recipient subject/message for the carrier
 * (recipient 1) and the Iron Wing countersigner (recipient 2).
 */
export function packetMessages(terms, { requestId }) {
    const legal = plain(terms.legal_name, 80);
    const plan = planLabel(terms);
    const date = effectiveDate(terms.effective_date);
    const reference = plain(String(requestId).slice(0, 8), 8);
    const mc = terms.mc_number ? plain(terms.mc_number, 20) : "none";
    return {
        name: plain(`Iron Wing dispatch agreement — ${legal}`, 150),
        carrier: {
            subject: plain(
                `Iron Wing: your dispatch agreement for ${legal} — please sign`,
                150
            ),
            message: [
                `This signature request is from ${REQUESTER_NAME}.`,
                "It contains your dispatch service agreement, limited power of attorney and payment authorization.",
                "Payment details are not entered here: they are collected separately on Stripe's secure page, linked after signing.",
                "If anything differs from what we agreed, reply to this email before signing.",
            ].join("\n"),
        },
        dispatch: {
            subject: plain(
                `INTERNAL — countersign: ${legal} (${plan}, effective ${date})`,
                150
            ),
            message: [
                "The carrier has signed.",
                "Before countersigning, check the legal name, MC/USDOT, plan/fee and effective date:",
                `${legal}; MC ${mc}; USDOT ${plain(terms.usdot, 10)}; ${plan}, fee ${feePercent(terms.fee_bp)}; effective ${date}.`,
                `Onboarding reference: ${reference}.`,
            ].join("\n"),
        },
    };
}
