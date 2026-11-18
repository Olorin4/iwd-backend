import { createHmac } from "node:crypto";
import { safeEqualHex } from "../signing.js";
import { SignatureError } from "./errors.js";

// SignWell adapter for the signature port (design §8): Create Document with
// uploaded files (no templates), draft first, then send. The API key is sent
// only as the X-Api-Key header and never appears in errors or logs.
export const SIGNWELL_BASE_URL = "https://www.signwell.com/api/v1";

/**
 * SignWell's pixel origin and scale are not documented. Every layout box
 * (PDF points, top-left origin) goes through this one function; the default
 * is identity with a top-left origin and is UNCALIBRATED until a draft
 * calibration document confirms or corrects it.
 */
export const DEFAULT_CALIBRATION = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    calibrated: false,
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
                required: true,
                ...toSignwellBox(field, calibration),
                recipient_id: String(field.recipient),
                api_id: `r${field.recipient}_${type}_${index + 1}`,
                ...(type === "date" && /lock_sign_date/.test(field.type)
                    ? { lock_sign_date: true }
                    : {}),
            };
        })
    );
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
        calibrated: !!calibration.calibrated,
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
                fields: signwellFields(filled.files, calibration),
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
