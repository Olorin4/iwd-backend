import { CARRIER_FACING_SLOTS } from "./readiness.js";
import { escapeHtml, textToHtml } from "../emailService.js";

// Plain, readable transactional email text (no JSON, no internal ids). The
// shared emailService adds the business signature.
const METHOD_LABELS = {
    card: "a card",
    us_bank_account: "a US bank account (ACH)",
};

/**
 * The continue URL may go into an href only when it is https, or uses the
 * scheme of the configured public base URL (http in a local sandbox).
 */
function safeHref(url, baseUrl) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    if (parsed.protocol === "https:") return url;
    try {
        if (baseUrl && parsed.protocol === new URL(baseUrl).protocol)
            return url;
    } catch {
        // an unparseable base URL allows nothing extra
    }
    return null;
}

const BUTTON_STYLE = [
    "display:inline-block",
    "background-color:#0b3d91",
    "border:2px solid #0b3d91",
    "border-radius:4px",
    "color:#ffffff",
    "font-family:Arial,Helvetica,sans-serif",
    "font-size:16px",
    "font-weight:bold",
    "line-height:20px",
    "padding:12px 24px",
    "text-decoration:none",
].join(";");

/**
 * A payment paragraph: in the text part the link stands alone on its own
 * line (`before`, url, `after`); in the HTML part it is a button-styled link
 * plus a small fallback line. Without a safe href the HTML part is the
 * escaped text, as for any other paragraph.
 */
function paymentBlock({ before, url, after, baseUrl }) {
    const text = [before, url, after].filter(Boolean).join("\n");
    const href = safeHref(url, baseUrl);
    if (!href) return { text, html: textToHtml(text) };
    const h = escapeHtml(href);
    return {
        text,
        html: [
            `<p>${escapeHtml(before)}</p>`,
            `<p style="margin:16px 0"><a href="${h}" style="${BUTTON_STYLE}">Save your payment method</a></p>`,
            `<p style="font-size:12px;color:#555555">or open this link: <a href="${h}" style="color:#0b3d91">${h}</a></p>`,
            ...(after ? [`<p>${escapeHtml(after)}</p>`] : []),
        ].join("\n"),
    };
}

/** Joins paragraphs (strings, or {text, html} blocks) into both parts. */
function compose(paragraphs) {
    return {
        text: paragraphs.map((p) => p.text ?? p).join("\n\n"),
        html: paragraphs.map((p) => p.html ?? textToHtml(p)).join("\n"),
    };
}

export function paymentLinkEmail({ terms, url, baseUrl }) {
    const methods = terms.payment_methods
        .map((m) => METHOD_LABELS[m])
        .join(" or ");
    return {
        subject: "Next step: save your payment method for Iron Wing",
        ...compose([
            `Hello ${terms.signer.name},`,
            `Thank you for signing the Iron Wing dispatch service agreement for ${terms.legal_name}.`,
            paymentBlock({
                before: `The next step is to save ${methods} on Stripe's secure page:`,
                url,
                baseUrl,
            }),
            "Saving the payment method does not charge you. Fees are charged only as described in your signed agreement and payment authorization.",
            "Stripe collects the card or bank details. We will never ask for card or bank account numbers by email or phone.",
            // The shared email signature (src/assets/signature.js) signs with the
            // legal name, Iron Wing Logistics L.L.C.; no second sign-off here.
            "If the link no longer works, reply to this email and we will send a new one.",
        ]),
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
            "Your carrier profile: equipment, preferred lanes, minimum rates, any freight you won't haul and any other preferences you have (a short list in the email is fine)",
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
export function completionEmail({ terms, requestId, url, baseUrl }) {
    const name = terms.legal_name;
    return {
        subject: `Your signed Iron Wing agreement and next steps — ${name} (ref ${refOf(requestId)})`,
        ...compose([
            `Hello ${terms.signer.name},`,
            "Thank you. Your dispatch service agreement, limited power of attorney and payment authorization are now signed by both parties. Your signed copy is attached to this email.",
            // The link stands on its own line with nothing after it: the token contains
            // dots, and a trailing full stop can be swallowed into the link by mail apps.
            paymentBlock({
                before: "Payment method: if you haven't finished saving it yet, use Stripe's secure page here:",
                url,
                after: "Nothing is charged when you save it. Never send card or bank account numbers by email.",
                baseUrl,
            }),
            `Documents we need before we start dispatching for ${name}. Please reply to this email with:\n${numbered(DOCUMENT_SLOTS, terms)}`,
        ]),
    };
}

/**
 * A documents reminder. `missingSlots` are the carrier-facing slots still
 * PENDING (in DOCUMENT_SLOTS order); `paymentUrl` is set only when the
 * payment method is not saved.
 */
export function reminderEmail({
    terms,
    requestId,
    missingSlots,
    paymentUrl,
    baseUrl,
}) {
    const name = terms.legal_name;
    const lines = [`We're still missing the following for ${name}:`];
    if (missingSlots.length) lines.push(numbered(missingSlots, terms));
    const listText = lines.join("\n");
    // In the text part the payment line continues the list (one paragraph);
    // in the HTML part it follows the list as its own button block.
    let body = listText;
    if (paymentUrl) {
        const pay = paymentBlock({
            before: "Your payment method: save it on Stripe's secure page here:",
            url: paymentUrl,
            baseUrl,
        });
        body = {
            text: `${listText}\n${pay.text}`,
            html: `${textToHtml(listText)}\n${pay.html}`,
        };
    }
    return {
        subject: `Reminder: still needed for your Iron Wing onboarding — ${name} (ref ${refOf(requestId)})`,
        ...compose([
            `Hello ${terms.signer.name},`,
            body,
            "Please reply to this email. If you have questions or need more time, just let us know.",
        ]),
    };
}
