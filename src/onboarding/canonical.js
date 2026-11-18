import { createHash } from "node:crypto";

// Canonical JSON for hashing confirmed terms (contract onboarding.request.v1):
// object keys sorted by UTF-16 code unit order (JavaScript's default sort) at
// every depth, array order kept, no whitespace, values serialized exactly as
// JSON.stringify does. `terms_hash` = lowercase hex SHA-256 of the UTF-8 bytes
// of canonicalJson(terms). Example: {"b":1,"a":[{"d":null,"c":"x"}]} becomes
// {"a":[{"c":"x","d":null}],"b":1}.
export function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const keys = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort();
        return `{${keys
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}

export const sha256Hex = (data) =>
    createHash("sha256").update(data).digest("hex");

export const termsHash = (terms) => sha256Hex(canonicalJson(terms));
