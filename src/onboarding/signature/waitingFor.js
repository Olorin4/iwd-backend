// Who the open packet is waiting for (R14). Pure; no I/O.
//
// Recipient ids follow the layout roles: "2" = Iron Wing (Dispatch fields,
// signs first), "1" = Carrier (signs last). SignWell's OpenAPI examples show
// provider-generated recipient ids on returned documents, so when none of our
// ids is present the recipient is matched by signing order instead
// (apply_signing_order: Iron Wing 1, carrier 2). Unverified until a sandbox run.
export const SIGNER_ROLES = {
    IRON_WING: { id: "2", signingOrder: 1 },
    CARRIER: { id: "1", signingOrder: 2 },
};
export const WAITING_FOR = ["IRON_WING", "CARRIER"];

// SignWell documents Recipients[].status only as a nullable string; its
// examples show "created" and "draft". Values outside these lists are unknown.
const SIGNED = ["completed", "signed"];
const NOT_SIGNED = [
    "created",
    "draft",
    "sending",
    "sent",
    "pending",
    "viewed",
    "opened",
    "awaiting_signature",
    "in_progress",
];

/** true (signed), false (not yet signed) or null (unknown status). */
export function recipientSigned(status) {
    if (typeof status !== "string") return null;
    const s = status
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    if (SIGNED.includes(s)) return true;
    if (NOT_SIGNED.includes(s)) return false;
    return null;
}

const ourIds = Object.values(SIGNER_ROLES).map((r) => r.id);

/** The recipient for a role, or null when absent or ambiguous. */
export function findRecipient(recipients, role) {
    const spec = SIGNER_ROLES[role];
    if (!spec || !Array.isArray(recipients)) return null;
    const list = recipients.filter((r) => r && typeof r === "object");
    const byId = list.filter((r) => String(r.id) === spec.id);
    if (byId.length > 0) return byId.length === 1 ? byId[0] : null;
    if (list.some((r) => ourIds.includes(String(r.id)))) return null;
    const byOrder = list.filter((r) => r.signing_order === spec.signingOrder);
    return byOrder.length === 1 ? byOrder[0] : null;
}

/**
 * signature.waiting_for: "IRON_WING" while the Iron Wing recipient has not
 * signed, "CARRIER" after it has and before the carrier has; null when the
 * packet is not SENT/VIEWED, a recipient is missing, a status is unknown, or
 * the statuses contradict the signing order.
 */
export function deriveWaitingFor(signatureState, recipients) {
    if (signatureState !== "SENT" && signatureState !== "VIEWED") return null;
    const ironWing = findRecipient(recipients, "IRON_WING");
    const carrier = findRecipient(recipients, "CARRIER");
    if (!ironWing || !carrier) return null;
    const ironWingSigned = recipientSigned(ironWing.status);
    const carrierSigned = recipientSigned(carrier.status);
    if (ironWingSigned === null || carrierSigned === null) return null;
    if (!ironWingSigned) return carrierSigned ? null : "IRON_WING";
    return carrierSigned ? null : "CARRIER";
}
