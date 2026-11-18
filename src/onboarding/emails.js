import { CARRIER_FACING_SLOTS } from "./readiness.js";

// Plain, readable transactional email text (no JSON, no internal ids). The
// shared emailService adds the business signature.
const METHOD_LABELS = {
    card: "a card",
    us_bank_account: "a US bank account (ACH)",
};

export function paymentLinkEmail({ terms, url }) {
    const methods = terms.payment_methods
        .map((m) => METHOD_LABELS[m])
        .join(" or ");
    return {
        subject: "Next step: save your payment method for Iron Wing",
        text: [
            `Hello ${terms.signer.name},`,
            `Thank you for signing the Iron Wing dispatch service agreement for ${terms.legal_name}.`,
            `The next step is to save ${methods} on Stripe's secure page:\n${url}`,
            "Saving the payment method does not charge you. Fees are charged only as described in your signed agreement and payment authorization.",
            "Stripe collects the card or bank details. We will never ask for card or bank account numbers by email or phone.",
            // The shared email signature (src/assets/signature.js) signs with the
            // legal name, Iron Wing Logistics L.L.C.; no second sign-off here.
            "If the link no longer works, reply to this email and we will send a new one.",
        ].join("\n\n"),
    };
}

// R15 (owner-approved texts, 2026-11-18). {ref} is the first 8 characters of
// the onboarding request id.
export const refOf = (requestId) => String(requestId).slice(0, 8);

const mcDigits = (mc) => (mc ? String(mc).replace(/^MC/i, "") : null);

/**
 * The carrier-facing documents, in email order, keyed by checklist slot
 * (FACTORING = FACTORING_NOA or NOT_FACTORING). FLEET_MAPPING is internal and
 * never appears in an email.
 */
export const DOCUMENT_SLOTS = CARRIER_FACING_SLOTS;

function documentLine(slot, terms) {
    const mc = mcDigits(terms.mc_number);
    return {
        W9: "A signed W-9 form",
        INSURANCE_COI: "Your certificate of insurance",
        // A request without an MC number names no MC (nothing invented).
        AUTHORITY_VERIFIED: mc
            ? `A copy of your operating authority (MC ${mc})`
            : "A copy of your operating authority",
        FACTORING:
            "Your factoring company's notice of assignment, or reply \"no factoring\" if you don't use one",
        CARRIER_PROFILE:
            "Your carrier profile: equipment, preferred lanes, minimum rates and any freight you won't haul (a short list in the email is fine)",
    }[slot];
}

const numbered = (slots, terms) =>
    slots.map((slot, i) => `${i + 1}. ${documentLine(slot, terms)}`).join("\n");

/** `Iron-Wing-agreement-{legal name slug}.pdf` */
export function agreementFilename(legalName) {
    const slug =
        String(legalName)
            .normalize("NFKD")
            .replace(/[^\x20-\x7e]/g, "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 80)
            .replace(/-+$/g, "") || "carrier";
    return `Iron-Wing-agreement-${slug}.pdf`;
}

/** The combined email at signature completion (signed copy attached). */
export function completionEmail({ terms, requestId, url }) {
    const name = terms.legal_name;
    return {
        subject: `Your signed Iron Wing agreement and next steps — ${name} (ref ${refOf(requestId)})`,
        text: [
            `Hello ${terms.signer.name},`,
            "Thank you. Your dispatch service agreement, limited power of attorney and payment authorization are now signed by both parties. Your signed copy is attached to this email.",
            // The link stands on its own line with nothing after it: the token contains
            // dots, and a trailing full stop can be swallowed into the link by mail apps.
            `Payment method: if you haven't finished saving it yet, use Stripe's secure page here:\n${url}\nNothing is charged when you save it. Never send card or bank account numbers by email.`,
            `Documents we need before we start dispatching for ${name}. Please reply to this email with:\n${numbered(DOCUMENT_SLOTS, terms)}`,
        ].join("\n\n"),
    };
}

/**
 * A documents reminder. `missingSlots` are the carrier-facing slots still
 * PENDING (in DOCUMENT_SLOTS order); `paymentUrl` is set only when the
 * payment method is not saved.
 */
export function reminderEmail({ terms, requestId, missingSlots, paymentUrl }) {
    const name = terms.legal_name;
    const lines = [`We're still missing the following for ${name}:`];
    if (missingSlots.length) lines.push(numbered(missingSlots, terms));
    if (paymentUrl)
        lines.push(
            `Your payment method: save it on Stripe's secure page here:\n${paymentUrl}`
        );
    return {
        subject: `Reminder: still needed for your Iron Wing onboarding — ${name} (ref ${refOf(requestId)})`,
        text: [
            `Hello ${terms.signer.name},`,
            lines.join("\n"),
            "Please reply to this email. If you have questions or need more time, just let us know.",
        ].join("\n\n"),
    };
}
