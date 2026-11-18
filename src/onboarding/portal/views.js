import { escapeHtml as html } from "../../emailService.js";
import { PORTAL_CARRIER_SLOTS, portalItemLabel } from "../portalEmails.js";
import { slotOf } from "../readiness.js";
import { EQUIPMENT_TYPES } from "../questionnaire.js";

const CONTACT = "onboarding@iron-wing-dispatching.com";
const safe = (value) => html(String(value ?? ""));

function shell(title, contents, script = false) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe(title)} | Iron Wing</title><link rel="stylesheet" href="/portal-static/portal.css?v=1"></head>
<body><header class="brand"><img src="/portal-static/logo.svg?v=1" alt="" width="56" height="56">
<span>Iron Wing Logistics L.L.C.</span></header><main>${contents}</main>
<footer>Questions? Reply to our email or write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</footer>
${script ? '<script src="/portal-static/portal.js?v=1" defer></script>' : ""}</body></html>`;
}

export function messagePage(title, message) {
    return shell(
        title,
        `<section class="card"><h1>${safe(title)}</h1><p>${safe(message)}</p></section>`
    );
}

export const inactivePage = () =>
    messagePage(
        "This link is no longer active",
        "This link is no longer active — contact " + CONTACT
    );

const errors = {
    too_large: "Choose a file no larger than 15 MB.",
    unsupported_type: "Choose a PDF, JPEG, PNG or HEIC file.",
    empty: "Choose a file to upload.",
    already_verified: "This item is already verified.",
    upload_unavailable:
        "Uploads are temporarily unavailable. Please try again.",
    request_closed: "This request is closed.",
};
const allowedUploads =
    "application/pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif";

function itemRow(row, slot, { base, csrf, closed, ownFiles }) {
    const item = row.operations.find((entry) => slotOf(entry.key) === slot);
    const key = slot === "FACTORING" ? "FACTORING_NOA" : slot;
    const label = portalItemLabel(key, row.terms);
    const state =
        {
            PENDING: "Needed",
            RECEIVED:
                item?.key === "NOT_FACTORING"
                    ? "No factoring — received"
                    : "Received — we’re reviewing it",
            VERIFIED:
                item?.key === "NOT_FACTORING"
                    ? "No factoring — verified ✓"
                    : "Verified ✓",
            REUPLOAD_REQUESTED: "New upload requested",
        }[item?.state] ?? "Needed";
    const file = ownFiles.find((document) => document.item_key === key);
    const ownLink = file
        ? `<p><a href="${base}/documents/${safe(file.id)}/file">Download your upload</a></p>`
        : "";
    const canUpload = !closed && item?.state !== "VERIFIED";
    return `<li><div><h3>${safe(label)}</h3><p class="state">${safe(state)}</p>
${item?.state === "REUPLOAD_REQUESTED" ? `<p class="notice">${safe(item.note)}</p>` : ""}${ownLink}</div>
${
    canUpload
        ? `<div class="controls"><form method="post" enctype="multipart/form-data" action="${base}/documents/${key}" data-upload>
<input type="hidden" name="csrf" value="${csrf}">
<label class="sr-only" for="file-${key}">Choose ${safe(label)}</label>
<input id="file-${key}" name="file" type="file" accept="${allowedUploads}" required>
<button type="submit">Upload</button><progress max="100" hidden></progress></form>
${
    slot === "FACTORING"
        ? `<form method="post" action="${base}/not-factoring" data-post><input type="hidden" name="csrf" value="${csrf}">
<button class="secondary" type="submit">I don't use factoring</button></form>`
        : ""
}</div>`
        : ""
}</li>`;
}

export function portalPage(
    row,
    {
        path,
        csrf,
        query = {},
        ownFiles = [],
        questionnaire = false,
        signed = false,
        returned = false,
    } = {}
) {
    const base = safe(path);
    const complete = signed || row.signature_state === "COMPLETED";
    const cancelled = Boolean(row.cancelled_at);
    const waiting = row.signature_waiting_for === "CARRIER";
    const locked = !complete || cancelled;
    const paid = ["READY", "PENDING_VERIFICATION"].includes(row.payment_state);
    const last4 = row.payment_last4 ? " •••• " + row.payment_last4 : "";
    const paymentStatus =
        row.payment_state === "READY"
            ? "Saved ✓" + last4
            : "Saved — awaiting bank verification" + last4;
    const signStatus = complete
        ? '<p class="state success">Signed ✓</p>'
        : cancelled ||
            ["DECLINED", "EXPIRED", "CANCELLED"].includes(row.signature_state)
          ? "<p>Signing is unavailable. Contact Iron Wing for help.</p>"
          : waiting
            ? `<a class="button" data-poll-link href="${base}/sign" target="_blank" rel="noopener noreferrer">Open agreement in SignWell</a>`
            : "<p>Iron Wing is preparing your agreement.</p>";
    const message =
        (Object.hasOwn(errors, query.error) ? errors[query.error] : null) ??
        (UPLOADABLE_NOTICE_KEYS.has(query.uploaded)
            ? "Your document was received."
            : null) ??
        (query.questionnaire === "saved"
            ? "Your preferences were saved."
            : null) ??
        (query.payment === "saved" && !paid
            ? "Checking your payment method…"
            : null) ??
        (query.payment === "cancelled"
            ? "Payment setup was cancelled. You can try again."
            : null);
    const poll =
        returned ||
        ["saved", "cancelled"].includes(query.payment) ||
        query.signature === "returned";
    return shell(
        row.terms.legal_name + " onboarding",
        `
<h1>Onboarding for ${safe(row.terms.legal_name)}</h1>
${cancelled ? "<p class='notice'>This request is closed. Contact Iron Wing for help.</p>" : ""}
${message ? `<p class="notice" role="status">${safe(message)}</p>` : ""}
<div data-portal data-status-url="${base}/status.json" data-poll="${poll}" data-signature="${safe(row.signature_state)}" data-payment="${safe(row.payment_state)}">
<section class="card"><h2><span class="step" aria-hidden="true">①</span> Sign your agreement</h2>
${signStatus}${row.signature_state === "COMPLETED" ? `<p><a href="${base}/agreement">Download signed agreement</a></p>` : ""}</section>
<section class="card"><h2><span class="step" aria-hidden="true">②</span> Save payment method</h2>
${
    paid
        ? `<p class="state success">${safe(paymentStatus)}</p>`
        : locked
          ? "<p>Available after you sign.</p>"
          : `<a class="button" data-poll-link href="${base}/payment" target="_blank" rel="noopener noreferrer">Save on Stripe</a><p>Nothing is charged when you save a payment method.</p>`
}</section>
<section class="card"><h2><span class="step" aria-hidden="true">③</span> Documents</h2>
${
    !complete
        ? "<p>Available after you sign.</p>"
        : `<ul class="documents">${PORTAL_CARRIER_SLOTS.map((slot) =>
              itemRow(row, slot, {
                  base,
                  csrf: safe(csrf),
                  closed: cancelled,
                  ownFiles,
              })
          ).join("")}</ul>`
}</section>
<section class="card"><h2><span class="step" aria-hidden="true">④</span> About your operation <small>Optional</small></h2>
${locked ? "<p>Available after you sign.</p>" : `<a href="${base}/questionnaire">${questionnaire ? "Edit your preferences" : "Answer a few questions"}</a>`}</section>
</div>`,
        true
    );
}

const UPLOADABLE_NOTICE_KEYS = new Set([
    "W9",
    "INSURANCE_COI",
    "AUTHORITY_VERIFIED",
    "FACTORING_NOA",
    "NOT_FACTORING",
]);

export function questionnairePage(
    row,
    { path, csrf, answers = {}, invalid = false }
) {
    const base = safe(path);
    const input = (name, label, props = "") =>
        `<label>${label}<input name="${name}" value="${safe(answers[name])}" ${props}></label>`;
    const area = (name, label, limit) =>
        `<label>${label}<textarea name="${name}" maxlength="${limit}">${safe(answers[name])}</textarea></label>`;
    return shell(
        "About your operation",
        `<p><a href="${base}">Back to onboarding</a></p><h1>About your operation</h1>
<p>Share your preferences with Iron Wing. Every field is optional.</p>
${invalid ? '<p class="notice" role="alert">Check the values and try again. Truck count must be between 1 and 500.</p>' : ""}
<form class="card questionnaire" method="post" action="${base}/questionnaire" data-post data-questionnaire>
<input type="hidden" name="csrf" value="${safe(csrf)}">
<fieldset><legend>Equipment types</legend><div class="equipment">${EQUIPMENT_TYPES.map(
            (equipment) =>
                `<label><input type="checkbox" name="equipment_types[]" value="${safe(equipment)}" ${answers.equipment_types?.includes(equipment) ? "checked" : ""}>${safe(equipment)}</label>`
        ).join("")}</div></fieldset>
${input("truck_count", "Truck count", 'type="number" min="1" max="500"')}
${input("home_base", "Home base", 'maxlength="300"')}
${area("preferred_lanes", "Preferred lanes or regions", 1000)}
${input("min_rate_per_mile", "Minimum rate per mile (USD)", 'type="number" min="0" step="0.01"')}
${input("min_rate_per_load", "Minimum rate per load (USD)", 'type="number" min="0" step="0.01"')}
${area("excluded_freight", "Freight you do not haul", 500)}
${input("max_deadhead_miles", "Maximum deadhead (miles)", 'type="number" min="0" step="1"')}
${area("availability", "Availability", 300)}
${area("other_preferences", "Other preferences", 2000)}
<button type="submit">Save preferences</button></form><p class="sr-only">${safe(row.terms.legal_name)}</p>`,
        true
    );
}
