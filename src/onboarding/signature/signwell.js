import { createHmac } from "node:crypto";
import { safeEqualHex } from "../signing.js";
import { SignatureError } from "./errors.js";

// SignWell adapter for the signature port (design §8): Create Document with
// uploaded files (no templates), draft first, then send. The API key is sent
// only as the X-Api-Key header and never appears in errors or logs.
export const SIGNWELL_BASE_URL = "https://www.signwell.com/api/v1";

const FIELD_TYPES = {
    signature: "signature",
    initials: "initials",
    date: "date",
    text: "text",
    name: "text",
};
const RECIPIENT_IDS = { carrier: "1", dispatch: "2" };

export function signwellFields(files) {
    return files.map((file) =>
        file.fields.map((field, index) => ({
            type: FIELD_TYPES[field.type],
            required: field.required !== false,
            x: field.x,
            y: field.y,
            page: field.page,
            recipient_id: RECIPIENT_IDS[field.recipient],
            api_id: `${field.recipient}_${field.type}_${index + 1}`,
            ...(field.width ? { width: field.width } : {}),
            ...(field.height ? { height: field.height } : {}),
            ...(field.type === "name"
                ? { label: field.label ?? "Name" }
                : field.label
                  ? { label: field.label }
                  : {}),
        }))
    );
}

export function createSignwellProvider({
    apiKey,
    testMode = true,
    expiresInDays = 14,
    timeoutMs = 15000,
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
                recipients: signers.map((s) => ({
                    id: s.id,
                    name: s.name,
                    email: s.email,
                })),
                fields: signwellFields(filled.files),
                apply_signing_order: true,
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
            };
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
