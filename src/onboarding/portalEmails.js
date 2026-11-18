import { escapeHtml, textToHtml } from "../emailService.js";
import { plain } from "./signature/messages.js";

export const PORTAL_CARRIER_SLOTS = [
    "W9",
    "INSURANCE_COI",
    "AUTHORITY_VERIFIED",
    "FACTORING",
];

export function portalItemLabel(key, terms = {}) {
    const mc = terms.mc_number?.replace(/^MC[ -]*/i, "");
    return (
        {
            W9: "W-9 form",
            INSURANCE_COI: "Certificate of insurance",
            AUTHORITY_VERIFIED: mc
                ? "Operating authority (MC " + mc + ")"
                : "Operating authority",
            FACTORING: "Factoring notice of assignment",
            FACTORING_NOA: "Factoring notice of assignment",
            NOT_FACTORING: "Factoring notice of assignment",
        }[key] ?? key
    );
}

function portalEmail({ subject, terms, intro, url, closing }) {
    const greeting = "Hello " + plain(terms.signer.name, 150) + ",";
    const text = [greeting, intro, url, closing].filter(Boolean).join("\n\n");
    const href = escapeHtml(url);
    const button =
        new URL(url).protocol === "https:"
            ? '<p><a style="display:inline-block;background:#0b3d91;color:#fff;padding:12px 24px;border-radius:4px;text-decoration:none" href="' +
              href +
              '">Open your onboarding page</a></p>'
            : "";
    const html = [
        textToHtml(greeting),
        textToHtml(intro),
        button,
        textToHtml(url),
        closing && textToHtml(closing),
    ]
        .filter(Boolean)
        .join("\n");
    return { subject, text, html };
}

export function invitationEmail({ terms, url }) {
    const legal = plain(terms.legal_name, 150);
    return portalEmail({
        subject: "Your Iron Wing onboarding page — " + legal,
        terms,
        url,
        intro: "Iron Wing Logistics L.L.C. has signed your dispatch service agreement. Your private onboarding page is ready:",
        closing:
            "On the page you can sign the agreement, save your payment method on Stripe's secure page, and upload your W-9, certificate of insurance, operating authority and factoring notice. Nothing is charged when you save a payment method. Please don't forward this link; it is private to " +
            legal +
            ".",
    });
}

export function portalReminderEmail({ terms, url, missing }) {
    return portalEmail({
        subject:
            "Reminder: your Iron Wing onboarding — " +
            plain(terms.legal_name, 150),
        terms,
        url,
        intro:
            "These onboarding steps are still open:\n" +
            missing.map((label) => "• " + label).join("\n"),
    });
}

export function reuploadEmail({ terms, url, itemLabel, reason }) {
    return portalEmail({
        subject:
            "Please upload a new " +
            itemLabel +
            " — " +
            plain(terms.legal_name, 150),
        terms,
        url,
        intro:
            "Please upload a new " + itemLabel + ".\n\n" + plain(reason, 300),
    });
}
