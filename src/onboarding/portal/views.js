import { escapeHtml as html } from "../../emailService.js";
import {
    PORTAL_CARRIER_SLOTS,
    PORTAL_REQUIRED_SLOTS,
    portalItemLabel,
} from "../portalEmails.js";
import { slotOf } from "../readiness.js";
import { portalSteps } from "./steps.js";
import { EQUIPMENT_TYPES } from "../questionnaire.js";
import { loadBoardGuide, loadBoardSummary } from "./loadBoards.js";

const CONTACT = "onboarding@iron-wing-dispatching.com";
const safe = (value) => html(String(value ?? ""));

function shell(title, contents) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe(title)} | Iron Wing</title><link rel="stylesheet" href="/portal-static/portal.css?v=10"></head>
<body><header class="brand"><img src="/portal-static/logo.svg?v=1" alt="" width="56" height="56">
<span>Iron Wing Logistics L.L.C.</span></header><main class="onboarding">${contents}</main>
<footer>Questions? Reply to our email or write to <a href="mailto:${CONTACT}">${CONTACT}</a>.</footer>
<script src="/portal-static/portal.js?v=5" defer></script></body></html>`;
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
    load_board_name: "Enter the name of the load board, then press Added.",
    invalid_load_board: "Choose a load board and try again.",
    mixed_files: "Send either one PDF or photos of the pages, not both.",
    too_many_pages: "Send at most 10 photos for one document.",
    too_large_set:
        "Together these photos are over 15 MB — send fewer pages or upload a PDF.",
    unreadable_photo:
        "One of the photos couldn’t be read. Take it again or upload a PDF.",
    busy: "We’re busy reading photos right now. Please try again in a minute.",
    photo_too_large:
        "A photo is too large to read. Take it again at a normal size or upload a PDF.",
};
const allowedUploads =
    "application/pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif";

const icon = {
    check: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"></path></svg>',
    upload: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 16V4"></path><path d="M7 9l5-5 5 5"></path><path d="M4 20h16"></path></svg>',
    doc: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5"></path><path d="M9 15l2 2 4-4"></path></svg>',
    warn: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"></path></svg>',
    camera: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>',
    hourglass:
        '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 3h12"></path><path d="M6 21h12"></path><path d="M7 3c0 5 10 5 10 9s-10 4-10 9"></path><path d="M17 3c0 5-10 5-10 9s10 4 10 9"></path></svg>',
};

function uploadForm({ base, csrf, key, label }) {
    return `<form class="upload" method="post" enctype="multipart/form-data" action="${base}/documents/${key}" data-upload>
<input type="hidden" name="csrf" value="${csrf}">
<div class="upload-actions"><label class="choose">Choose file<input name="file" type="file" multiple accept="${allowedUploads}" aria-label="Choose ${safe(label)}"></label>
<label class="take-photos">${icon.camera}Take photos<input name="file" type="file" accept="image/*" capture="environment" aria-label="Take photos of ${safe(label)}"></label></div>
<div class="photo-list" hidden></div>
<button type="submit">Upload</button><progress max="100" hidden></progress></form>`;
}

// One document row (owner-approved redesign, A-style rows).
function itemRow(row, slot, { base, csrf, closed, ownFiles }) {
    const item = row.operations.find((entry) => slotOf(entry.key) === slot);
    const key = slot === "FACTORING" ? "FACTORING_NOA" : slot;
    const label = portalItemLabel(key, row.terms);
    const optional = slot === "FACTORING";
    const state = item?.state ?? "PENDING";
    const file = ownFiles.find((document) => document.item_key === key);
    const ownLink = file
        ? ` · <a href="${base}/documents/${safe(file.id)}/file">your upload</a>`
        : "";
    const status =
        item?.key === "NOT_FACTORING"
            ? "No factoring"
            : ({
                  RECEIVED: `Received — we’re reviewing it${ownLink}`,
                  VERIFIED: `Verified ✓${ownLink}`,
                  REUPLOAD_REQUESTED: `Iron Wing asks: ${safe(item?.note)}`,
              }[state] ??
              (optional
                  ? "Only if you use a factoring company"
                  : "PDF, or a photo of each page"));
    const kind =
        state === "VERIFIED" || state === "RECEIVED"
            ? "done"
            : state === "REUPLOAD_REQUESTED"
              ? "redo"
              : "needed";
    const canUpload = !closed && state !== "VERIFIED";
    return `<li class="doc doc-${kind}${optional ? " doc-optional" : ""}"${optional ? ' id="factoring"' : ""}>
<div class="doc-head"><span class="doc-icon">${kind === "done" ? icon.doc : kind === "redo" ? icon.warn : icon.upload}</span>
<div><h4>${safe(label)}${optional ? ' <span class="chip">Optional</span>' : ""}</h4><p class="doc-status">${status}</p></div></div>
${canUpload && kind !== "done" ? uploadForm({ base, csrf, key, label }) : ""}</li>`;
}

const STEP_TITLES = {
    sign: ["Sign your agreement", "Agreement signed"],
    payment: ["Save payment method", "Payment method saved"],
    documents: ["Upload your documents", "Documents sent"],
    loadBoard: ["Set up load board access", "Load board access confirmed"],
    about: ["About your operation", "About your operation"],
};

function stepNode(step, number) {
    return step.state === "done"
        ? `<span class="node node-done">${icon.check}</span>`
        : `<span class="node node-${step.state}" aria-hidden="true">${number}</span>`;
}

function step(stepModel, number, { open, subtitle, body }) {
    const [todo, done] = STEP_TITLES[stepModel.id];
    const title = stepModel.state === "done" ? done : todo;
    return `<li class="step step-${stepModel.state}">${stepNode(stepModel, number)}
<details${open ? " open" : ""}><summary>${stepModel.state === "current" ? '<span class="here">You are here</span>' : ""}<span class="step-title">${title}${stepModel.state === "done" ? '<span class="sr-only"> (done)</span>' : ""}${stepModel.id === "about" ? " <small>· optional</small>" : ""}</span>${subtitle ? `<span class="step-sub">${subtitle}</span>` : ""}</summary>
<div class="step-body">${body}</div></details></li>`;
}

// Once READY: the completion hero at the top of the page.
function readyHero(base, dispatcher) {
    return `<section class="ready-hero" role="status">
<svg width="120" height="120" viewBox="0 0 120 120" role="img" aria-label="Onboarding complete"><circle cx="60" cy="60" r="54" fill="none" stroke="rgba(255,200,0,0.3)" stroke-width="10"></circle><circle cx="60" cy="60" r="44" fill="#ffc800"></circle><path d="M40 61l14 14 27-29" fill="none" stroke="#080d17" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"></path></svg>
<h2>You’re ready</h2>
<p>Your onboarding with Iron Wing is complete: your agreement is signed, your payment method is saved, your documents are verified and your dispatcher has load board access.</p>
<p>${dispatcher ? `Your dispatcher <strong>${safe(dispatcher.name)}</strong>` : "Your Iron Wing dispatcher"} will contact you to plan your first loads.</p>
<a class="button" href="${base}/agreement">Download your signed agreement</a>
<p class="fine">This page stays available for 30 days.</p></section>`;
}

const UPLOAD_ERRORS = new Set([
    "too_large",
    "unsupported_type",
    "empty",
    "already_verified",
    "upload_unavailable",
    "mixed_files",
    "too_many_pages",
    "too_large_set",
    "unreadable_photo",
    "photo_too_large",
    "busy",
]);

export function portalPage(
    row,
    {
        path,
        csrf,
        query = {},
        ownFiles = [],
        questionnaire = false,
        dispatcher = null,
        signed = false,
        returned = false,
    } = {}
) {
    const base = safe(path);
    const view = signed ? { ...row, signature_state: "COMPLETED" } : row;
    const model = portalSteps(view);
    const complete = view.signature_state === "COMPLETED";
    const cancelled = Boolean(row.cancelled_at);
    const waiting = row.signature_waiting_for === "CARRIER";
    const locked = !complete || cancelled;
    const paid = ["READY", "PENDING_VERIFICATION"].includes(row.payment_state);
    const method =
        row.payment_method_type === "us_bank_account" ? "Bank account" : "Card";
    const last4 = row.payment_last4 ? " •••• " + row.payment_last4 : "";
    const paymentStatus =
        row.payment_state === "READY"
            ? `${method}${last4} saved ✓ · nothing charged`
            : `${method}${last4} saved — awaiting bank verification`;
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
    const byId = Object.fromEntries(model.steps.map((s) => [s.id, s]));
    const openOn = {
        documents:
            UPLOAD_ERRORS.has(query.error) ||
            UPLOADABLE_NOTICE_KEYS.has(query.uploaded),
        loadBoard:
            query.board === "added" ||
            String(query.error ?? "").includes("load_board"),
    };
    // Iron Wing asked for a new file (also after READY, e.g. factoring):
    // open the documents step and say so at the top.
    const redo = (row.operations ?? []).some(
        (i) =>
            PORTAL_CARRIER_SLOTS.includes(slotOf(i.key)) &&
            i.state === "REUPLOAD_REQUESTED"
    );
    if (redo && complete && !cancelled) openOn.documents = true;
    const isOpen = (id) => byId[id].state === "current" || Boolean(openOn[id]);
    const docItems = (row.operations ?? []).filter((i) =>
        PORTAL_REQUIRED_SLOTS.includes(slotOf(i.key))
    );
    const docsVerified =
        docItems.length > 0 && docItems.every((i) => i.state === "VERIFIED");
    const signBody = complete
        ? `<p class="state success">Signed ✓</p><p><a href="${base}/agreement">Download signed agreement</a></p>`
        : cancelled ||
            ["DECLINED", "EXPIRED", "CANCELLED"].includes(row.signature_state)
          ? "<p>Signing is unavailable. Contact Iron Wing for help.</p>"
          : waiting
            ? `<a class="button" data-poll-link href="${base}/sign" target="_blank" rel="noopener noreferrer">Open agreement in SignWell</a>`
            : "<p>Iron Wing is preparing your agreement.</p>";
    const paymentBody = paid
        ? `<p class="state success">${safe(paymentStatus)}</p>`
        : locked
          ? "<p>Available after you sign.</p>"
          : `<a class="button" data-poll-link href="${base}/payment" target="_blank" rel="noopener noreferrer">Save on Stripe</a><p class="fine">Nothing is charged when you save a payment method.</p>`;
    const documentsBody = !complete
        ? "<p>Available after you sign.</p>"
        : `<ul class="docs">${PORTAL_CARRIER_SLOTS.map((slot) =>
              itemRow(row, slot, {
                  base,
                  csrf: safe(csrf),
                  closed: cancelled,
                  ownFiles,
              })
          ).join("")}</ul>`;
    const loadBoardBody = cancelled
        ? "<p>This request is closed.</p>"
        : locked
          ? "<p>Available after you sign.</p>"
          : loadBoardGuide({
                base,
                csrf: safe(csrf),
                dispatcher,
                item: row.operations.find(
                    (entry) => entry.key === "LOAD_BOARD_ACCESS"
                ),
                justAdded: query.board === "added",
            });
    const lbItem = row.operations.find(
        (entry) => entry.key === "LOAD_BOARD_ACCESS"
    );
    const subtitles = {
        sign: complete ? "Signed ✓ · tap for your copy" : "",
        payment: paid ? safe(paymentStatus) : "",
        documents: redo
            ? "Iron Wing asked for a new file"
            : byId.documents.state === "done"
              ? docsVerified
                  ? "All verified ✓"
                  : "Received · Iron Wing is reviewing"
              : complete
                ? "PDF, or photos of each page"
                : "",
        loadBoard: safe(loadBoardSummary(lbItem, dispatcher)),
        about: questionnaire
            ? "Your preferences are saved"
            : "Lanes, rates, equipment, factoring company",
    };
    const n = model.doneCount;
    return shell(
        row.terms.legal_name + " onboarding",
        `
<section class="progress"><h1>Onboarding for ${safe(row.terms.legal_name)}</h1>
<p class="progress-count">${n} of 4 steps done</p><div class="bar bar-${n}" aria-hidden="true"><span></span></div></section>
${model.phase === "ready" ? readyHero(base, dispatcher) : ""}
${model.phase === "allSet" ? `<section class="all-set" role="status">${icon.hourglass}<p>All set on your side. Iron Wing is reviewing your documents and setting up your account — you’ll see You’re ready here when we’re done. Nothing else to do.</p></section>` : ""}
${cancelled ? "<p class='notice'>This request is closed. Contact Iron Wing for help.</p>" : ""}
${redo && complete && !cancelled ? '<p class="notice" role="status">Iron Wing asked for a new file — see your documents below.</p>' : ""}
${message ? `<p class="notice" role="status">${safe(message)}</p>` : ""}
<div data-portal data-status-url="${base}/status.json" data-poll="${poll}" data-signature="${safe(row.signature_state)}" data-payment="${safe(row.payment_state)}">
<ol class="timeline">
${step(byId.sign, 1, { open: isOpen("sign"), subtitle: subtitles.sign, body: signBody })}
${step(byId.payment, 2, { open: isOpen("payment"), subtitle: subtitles.payment, body: paymentBody })}
${step(byId.documents, 3, { open: isOpen("documents"), subtitle: subtitles.documents, body: documentsBody })}
${step(byId.loadBoard, 4, { open: isOpen("loadBoard"), subtitle: subtitles.loadBoard, body: loadBoardBody })}
${step(byId.about, 5, { open: query.questionnaire === "saved", subtitle: subtitles.about, body: locked ? "<p>Available after you sign.</p>" : `<a href="${base}/questionnaire">${questionnaire ? "Edit your preferences" : "Answer a few questions"}</a>` })}
</ol></div>`
    );
}

const UPLOADABLE_NOTICE_KEYS = new Set([
    "W9",
    "INSURANCE_COI",
    "AUTHORITY_VERIFIED",
    "FACTORING_NOA",
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
<button type="submit">Save preferences</button></form><p class="sr-only">${safe(row.terms.legal_name)}</p>`
    );
}
