import { createHmac } from "node:crypto";
import { safeEqualHex } from "./signing.js";

// Signed, expiring link token for /onboarding/continue/:token (SignWell
// redirect_url and the payment email). Carries only the request id.
const b64 = (value) => Buffer.from(value).toString("base64url");
const mac = (secret, data) =>
    createHmac("sha256", secret).update(data).digest("hex");

export function createContinueToken(secret, requestId, expiresAtSeconds) {
    const body = b64(JSON.stringify({ r: requestId, e: expiresAtSeconds }));
    return `${body}.${mac(secret, body)}`;
}

/** Returns { requestId } or { error: "invalid" | "expired" }. */
export function verifyContinueToken(secret, token, nowSeconds) {
    if (typeof token !== "string" || token.length > 400)
        return { error: "invalid" };
    const [body, signature, extra] = token.split(".");
    if (
        !body ||
        !signature ||
        extra !== undefined ||
        !safeEqualHex(mac(secret, body), signature)
    )
        return { error: "invalid" };
    let payload;
    try {
        payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
        return { error: "invalid" };
    }
    if (typeof payload?.r !== "string" || !Number.isInteger(payload?.e))
        return { error: "invalid" };
    if (payload.e < nowSeconds) return { error: "expired" };
    return { requestId: payload.r };
}

/**
 * Where SignWell sends EVERY signer after signing. SignWell's redirect_url is
 * per document, not per recipient, and the carrier signs first, so a payment
 * link here would only ever reach the Iron Wing countersigner (sandbox finding
 * 2026-11-18). It is therefore a neutral page; the carrier gets the payment
 * step by email once both have signed.
 */
export function signedPageUrl(config) {
    return `${config.publicBaseUrl}/onboarding/signed`;
}

export function continueUrl(config, requestId, now = new Date()) {
    const exp = Math.floor(now.getTime() / 1000) + config.continueTtlSeconds;
    return `${config.publicBaseUrl}/onboarding/continue/${createContinueToken(config.continueSecret, requestId, exp)}`;
}
