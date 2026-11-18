import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// App-to-app request signing (design §5):
// X-IW-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export function signBody(secret, rawBody, nowSeconds) {
    const t = String(nowSeconds);
    const v1 = createHmac("sha256", secret)
        .update(`${t}.`)
        .update(rawBody ?? "")
        .digest("hex");
    return `t=${t},v1=${v1}`;
}

export function parseSignatureHeader(header) {
    if (typeof header !== "string" || header.length > 300) return null;
    const parts = Object.fromEntries(
        header.split(",").map((part) => {
            const index = part.indexOf("=");
            return [part.slice(0, index).trim(), part.slice(index + 1).trim()];
        })
    );
    if (
        !/^\d{1,12}$/.test(parts.t ?? "") ||
        !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")
    )
        return null;
    return { t: Number(parts.t), v1: parts.v1 };
}

export function safeEqualHex(a, b) {
    // Strict: Buffer.from(…, "hex") silently drops trailing junk.
    const hex = /^(?:[0-9a-f]{2})+$/;
    if (
        typeof a !== "string" ||
        typeof b !== "string" ||
        !hex.test(a) ||
        !hex.test(b)
    )
        return false;
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return (
        left.length === right.length &&
        left.length > 0 &&
        timingSafeEqual(left, right)
    );
}

/** Returns null when valid, otherwise a short reason code. */
export function verifySignature({ secret, header, rawBody, nowSeconds }) {
    const parsed = parseSignatureHeader(header);
    if (!parsed) return "signature_missing";
    if (Math.abs(nowSeconds - parsed.t) > SIGNATURE_TOLERANCE_SECONDS)
        return "signature_expired";
    const expected = signBody(secret, rawBody, parsed.t).split("v1=")[1];
    return safeEqualHex(expected, parsed.v1) ? null : "signature_invalid";
}

/** Constant-time bearer comparison over SHA-256 digests (length-independent). */
export function bearerMatches(header, expectedToken) {
    if (typeof header !== "string" || !expectedToken) return false;
    const match = /^Bearer (\S{1,512})$/.exec(header);
    if (!match) return false;
    const digest = (value) => createHash("sha256").update(value).digest();
    return timingSafeEqual(digest(match[1]), digest(expectedToken));
}
