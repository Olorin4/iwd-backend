import { createHmac } from "node:crypto";
import { safeEqualHex } from "../signing.js";
import { SignatureError } from "./errors.js";
import { SIGNER_ROLES, findRecipient } from "./waitingFor.js";

// SignWell adapter for the signature port (design §8): Create Document with
// uploaded files (no templates), draft first, then send. The API key is sent
// only as the X-Api-Key header and never appears in errors or logs.
export const SIGNWELL_BASE_URL = "https://www.signwell.com/api/v1";

/**
 * Every layout box (PDF points, top-left origin) goes through this one
 * function. Calibrated 2026-11-18 against release v1 with test-mode drafts
 * measured in SignWell's editor: SignWell uses a TOP-LEFT origin in CSS
 * pixels at 96 DPI (letter = 816×1056), so x, y, width and height are PDF
 * points × 4/3 (within ~2 pt for x/y, exact for widths).
 */
export const POINTS_TO_SIGNWELL = 4 / 3;
export const DEFAULT_CALIBRATION = {
    scale: POINTS_TO_SIGNWELL,
    offsetX: 0,
    offsetY: 0,
};

export function toSignwellBox(field, calibration = DEFAULT_CALIBRATION) {
    const { scale, offsetX, offsetY } = calibration;
    const round = (v) => Math.round(v * 100) / 100;
    return {
        page: field.page,
        x: round(field.x * scale + offsetX),
        y: round(field.y * scale + offsetY),
        width: round(field.w * scale),
        height: round(field.h * scale),
    };
}

const fieldType = (type) => type.match(/^(signature|initials|date|text)/)[1];

export function signwellFields(files, calibration = DEFAULT_CALIBRATION) {
    return files.map((file) =>
        file.fields.map((field, index) => {
            const type = fieldType(field.type);
            return {
                type,
                required: field.required !== false,
                ...toSignwellBox(field, calibration),
                recipient_id: String(field.recipient),
                api_id: `r${field.recipient}_${type}_${index + 1}`,
                ...(type === "date" && /lock_sign_date/.test(field.type)
                    ? { lock_sign_date: true }
                    : {}),
                ...(type === "text"
                    ? {
                          ...(field.label ? { label: field.label } : {}),
                          ...(field.fixed_width ? { fixed_width: true } : {}),
                          ...(field.validation_regex
                              ? {
                                    validation: "custom",
                                    validation_regex: field.validation_regex,
                                    validation_regex_error_message:
                                        field.validation_regex_error_message,
                                }
                              : {}),
                      }
                    : {}),
            };
        })
    );
}

/**
 * Embedded signing (owner ruling R14, 2026-11-18): the owner signs as Iron
 * Wing inside Outreach through the recipient's `embedded_signing_url`; the
 * carrier keeps normal email signing. Field names and units are from
 * SignWell's OpenAPI file (DocumentRequest / UpdateDocumentAndSendRequest /
 * Recipients):
 * - `embedded_signing` (boolean, default false): enables embedded signing.
 * - `embedded_signing_notifications` (boolean, default false): "On embedding
 *   signing, document owners (and CC'd contacts) do not get a notification
 *   email when documents have been completed". Left at the default (not
 *   sent): no CC contacts are used, the owner turns off account-owner
 *   notification emails anyway (ops doc "Owner settings in SignWell"), and
 *   iwd stores the completed PDF for Outreach.
 * - Recipients[].`send_email` (boolean, default false): "Applies on when
 *   `embedded_signing` is `true`. By default, recipients are not notified
 *   through email" — true for both recipients (the carrier signs by email).
 * - Recipients[].`send_email_delay` (integer, minutes, 0–60, default 0):
 *   with embedded signing the email "will not go out if the document is
 *   completed before the delay time is over". Set only for the Iron Wing
 *   recipient (signer.emailDelayMinutes).
 * The send call repeats `embedded_signing` because
 * UpdateDocumentAndSendRequest also carries it with default false.
 */
export const EMBEDDED_DOCUMENT_FLAGS = { embedded_signing: true };

export function signwellRecipient(signer) {
    return {
        id: signer.id,
        name: signer.name,
        email: signer.email,
        ...(signer.subject ? { subject: signer.subject } : {}),
        ...(signer.message ? { message: signer.message } : {}),
        send_email: true,
        ...(Number.isInteger(signer.emailDelayMinutes)
            ? { send_email_delay: signer.emailDelayMinutes }
            : {}),
    };
}

/**
 * Recipients of a fetched document reduced to { id, status, signing_order }
 * (DocumentResponse.recipients[]): never names, emails or signing URLs.
 */
export function signwellRecipientStatuses(recipients) {
    if (!Array.isArray(recipients)) return [];
    return recipients
        .filter((r) => r && typeof r === "object")
        .map((r) => ({
            id: r.id === undefined || r.id === null ? null : String(r.id),
            status: typeof r.status === "string" ? r.status : null,
            signing_order: Number.isInteger(r.signing_order)
                ? r.signing_order
                : null,
        }));
}

export function createSignwellProvider({
    apiKey,
    testMode = true,
    expiresInDays = 14,
    timeoutMs = 15000,
    calibration = DEFAULT_CALIBRATION,
    baseUrl = SIGNWELL_BASE_URL,
    fetch: fetchImpl = globalThis.fetch,
}) {
    async function call(method, path, body, { binary = false } = {}) {
        let response;
        try {
            response = await fetchImpl(`${baseUrl}${path}`, {
                method,
                headers: {
                    "X-Api-Key": apiKey,
                    Accept: binary ? "application/pdf" : "application/json",
                    ...(body ? { "Content-Type": "application/json" } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            const timeout =
                error?.name === "TimeoutError" || error?.name === "AbortError";
            throw new SignatureError(
                timeout ? "provider_timeout" : "provider_unreachable",
                { ambiguous: true }
            );
        }
        if (!response.ok)
            throw new SignatureError(`provider_http_${response.status}`, {
                status: response.status,
                ambiguous: response.status >= 500,
            });
        if (binary) return Buffer.from(await response.arrayBuffer());
        if (response.status === 204) return null;
        try {
            return await response.json();
        } catch {
            throw new SignatureError("provider_bad_response", {
                ambiguous: true,
            });
        }
    }

    return {
        name: "signwell",
        async createEnvelope(filled, signers, metadata) {
            const document = await call("POST", "/documents/", {
                test_mode: testMode,
                draft: true,
                name: metadata.name,
                subject: metadata.subject,
                message: metadata.message,
                files: filled.files.map((f) => ({
                    name: f.name,
                    file_base64: f.bytes.toString("base64"),
                })),
                ...(metadata.requester_name
                    ? { custom_requester_name: metadata.requester_name }
                    : {}),
                ...(metadata.requester_email
                    ? { custom_requester_email: metadata.requester_email }
                    : {}),
                recipients: signers.map(signwellRecipient),
                fields: signwellFields(filled.files, calibration),
                apply_signing_order: true,
                ...EMBEDDED_DOCUMENT_FLAGS,
                reminders: false,
                allow_decline: true,
                expires_in: expiresInDays,
                redirect_url: metadata.redirect_url,
                metadata: {
                    onboarding_request_id: metadata.onboarding_request_id,
                    envelope_id: metadata.envelope_id,
                },
            });
            if (typeof document?.id !== "string")
                throw new SignatureError("provider_bad_response");
            return { id: document.id, status: document.status ?? "draft" };
        },
        async send(id) {
            await call("POST", `/documents/${encodeURIComponent(id)}/send/`, {
                test_mode: testMode,
                ...EMBEDDED_DOCUMENT_FLAGS,
            });
        },
        async get(id) {
            const document = await call(
                "GET",
                `/documents/${encodeURIComponent(id)}/`
            );
            return {
                id: document.id,
                status: document.status,
                metadata: document.metadata ?? {},
                recipients: signwellRecipientStatuses(document.recipients),
            };
        },
        /**
         * The recipient's DocumentResponse.recipients[].embedded_signing_url
         * from GET /documents/:id (R14), or null. The URL is a bearer link:
         * callers must never log or cache it.
         */
        async embeddedSigningUrl(id, recipientId) {
            const document = await call(
                "GET",
                `/documents/${encodeURIComponent(id)}/`
            );
            const recipients = Array.isArray(document?.recipients)
                ? document.recipients
                : [];
            const role = Object.keys(SIGNER_ROLES).find(
                (key) => SIGNER_ROLES[key].id === recipientId
            );
            const recipient = role
                ? findRecipient(recipients, role)
                : recipients.find((r) => String(r?.id) === recipientId);
            const url = recipient?.embedded_signing_url;
            return typeof url === "string" && url.startsWith("https://")
                ? url
                : null;
        },
        async downloadCompleted(id) {
            const bytes = await call(
                "GET",
                `/documents/${encodeURIComponent(id)}/completed_pdf/?url_only=false&audit_page=true`,
                null,
                { binary: true }
            );
            if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
                throw new SignatureError("completed_pdf_invalid");
            return bytes;
        },
        async delete(id) {
            await call("DELETE", `/documents/${encodeURIComponent(id)}/`);
        },
    };
}

/** Canonical decimal form of an integer event time, or null. */
export function canonicalEventTime(time) {
    if (typeof time === "number" && Number.isSafeInteger(time) && time >= 0)
        return String(time);
    if (typeof time === "string" && /^\d{1,15}$/.test(time))
        return String(Number(time));
    return null;
}

/**
 * SignWell webhook check: event.hash must be exactly 64 lowercase hex chars
 * and equal hex HMAC-SHA256 with the webhook id as key over
 * "<type>@<canonical time>". The hash does not cover the body, so the event is
 * only a hint and the document is always re-fetched.
 * Returns { type, time, expected } (server-computed hash) or null.
 */
export function verifySignwellEvent(body, webhookId) {
    const event = body?.event;
    if (
        !event ||
        typeof event.type !== "string" ||
        !/^[a-z_]{1,64}$/.test(event.type)
    )
        return null;
    if (typeof event.hash !== "string" || !/^[0-9a-f]{64}$/.test(event.hash))
        return null;
    const time = canonicalEventTime(event.time);
    if (time === null) return null;
    const expected = createHmac("sha256", webhookId)
        .update(`${event.type}@${time}`)
        .digest("hex");
    return safeEqualHex(expected, event.hash)
        ? { type: event.type, time, expected }
        : null;
}

export function signSignwellEvent(type, time, webhookId) {
    return createHmac("sha256", webhookId)
        .update(`${type}@${time}`)
        .digest("hex");
}
