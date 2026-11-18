import { safeEqualHex } from "../signing.js";
import { portalMac } from "./token.js";

export const csrfToken = (secret, tokenId) =>
    portalMac(secret, "csrf", tokenId);

export function validCsrf(secret, tokenId, value) {
    return (
        typeof value === "string" &&
        /^[a-f0-9]{64}$/.test(value) &&
        safeEqualHex(csrfToken(secret, tokenId), value)
    );
}
