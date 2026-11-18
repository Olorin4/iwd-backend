import { createHmac } from "node:crypto";
import { safeEqualHex } from "../signing.js";

const ID = /^[A-Za-z0-9_-]{22}$/;
const MAC = /^[a-f0-9]{64}$/;

export function portalMac(secret, context, tokenId) {
    return createHmac("sha256", secret)
        .update(context + ":" + tokenId)
        .digest("hex");
}

export function createPortalToken(secret, tokenId) {
    return tokenId + "." + portalMac(secret, "portal", tokenId);
}

export function parsePortalToken(secret, token) {
    if (!secret || typeof token !== "string" || token.length > 120)
        return { error: "invalid" };
    const parts = token.split(".");
    const [tokenId, mac] = parts;
    if (
        parts.length !== 2 ||
        !ID.test(tokenId) ||
        !MAC.test(mac) ||
        !safeEqualHex(portalMac(secret, "portal", tokenId), mac)
    )
        return { error: "invalid" };
    return { tokenId };
}
