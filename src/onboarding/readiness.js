// Pure onboarding state rules (design §7). No I/O.

export const OPERATION_SLOTS = [
    "AUTHORITY_VERIFIED",
    "INSURANCE_COI",
    "W9",
    "FACTORING", // satisfied by FACTORING_NOA or NOT_FACTORING
    "CARRIER_PROFILE",
    "FLEET_MAPPING",
];
const FACTORING_KEYS = ["FACTORING_NOA", "NOT_FACTORING"];

export const slotOf = (key) =>
    FACTORING_KEYS.includes(key) ? "FACTORING" : key;

/** The initial checklist: six required items, all PENDING. */
export function initialOperations() {
    return OPERATION_SLOTS.map((slot) => ({
        key: slot === "FACTORING" ? "FACTORING_NOA" : slot,
        state: "PENDING",
        at: null,
        actor: null,
        note: null,
    }));
}

/**
 * Marks one item VERIFIED. NOT_FACTORING and FACTORING_NOA share a slot: the
 * verified key replaces the slot's key. Returns a new array.
 */
export function verifyOperationItem(items, key, { actor, note = null, at }) {
    const slot = slotOf(key);
    if (!OPERATION_SLOTS.includes(slot))
        throw new Error("unknown_operation_item");
    return items.map((item) =>
        slotOf(item.key) === slot
            ? { key, state: "VERIFIED", at: at.toISOString(), actor, note }
            : item
    );
}

export const operationsState = (items) =>
    items.length === OPERATION_SLOTS.length &&
    items.every((i) => i.state === "VERIFIED")
        ? "COMPLETE"
        : "PENDING";

const CLOSED_SIGNATURE = ["DECLINED", "EXPIRED", "CANCELLED"];
const PROVISIONED = ["SUCCEEDED", "MANUAL_CONFIRMED"];

/**
 * Derives readiness and the blocking reason from the four facets.
 * input: { cancelled, signature, signatureCode, payment, paymentCode,
 *          provisioning, provisioningCode, operations: "PENDING"|"COMPLETE" }
 * CLOSED by a declined/expired/cancelled packet still names reissue_packet as
 * the available recovery; a cancelled request has no action.
 */
export function deriveReadiness(f) {
    if (f.cancelled) return { readiness: "CLOSED", blocked: null };
    if (CLOSED_SIGNATURE.includes(f.signature))
        return {
            readiness: "CLOSED",
            blocked: {
                code: `signature_${f.signature.toLowerCase()}`,
                action: "reissue_packet",
            },
        };
    if (
        f.signature === "COMPLETED" &&
        f.payment === "READY" &&
        PROVISIONED.includes(f.provisioning) &&
        f.operations === "COMPLETE"
    )
        return { readiness: "READY", blocked: null };

    const block = (code, action) => ({
        readiness: "BLOCKED",
        blocked: { code, action },
    });
    if (f.signature === "UNKNOWN")
        return block(f.signatureCode || "signature_unknown", "reconcile");
    if (f.signature === "ERROR")
        return block(f.signatureCode || "signature_error", "reissue_packet");
    if (f.signature === "NOT_SENT" && f.signatureCode)
        return block(f.signatureCode, "reconcile");
    // An open packet with a code (e.g. audit_page_missing) waits on reconcile.
    if (["SENT", "VIEWED"].includes(f.signature) && f.signatureCode)
        return block(f.signatureCode, "reconcile");
    if (f.payment === "FAILED")
        return block(f.paymentCode || "payment_failed", "resend_payment_link");
    if (f.provisioning === "FAILED")
        return block(
            f.provisioningCode || "provisioning_failed",
            "retry_provisioning"
        );
    if (f.provisioning === "MANUAL_REQUIRED")
        return block(
            f.provisioningCode || "manual_provisioning_required",
            "confirm_provisioning"
        );
    return { readiness: "IN_PROGRESS", blocked: null };
}

/** Facets of a stored onboarding_request row. */
export const facetsOf = (row) => ({
    cancelled: !!row.cancelled_at,
    signature: row.signature_state,
    signatureCode: row.signature_code,
    payment: row.payment_state,
    paymentCode: row.payment_code,
    provisioning: row.provisioning_state,
    provisioningCode: row.provisioning_code,
    operations: operationsState(row.operations ?? []),
});

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Builds the full onboarding.status.v1 payload from a stored request row. */
export function buildStatus(row, { eventId, occurredAt, signedAvailable }) {
    const { readiness, blocked } = deriveReadiness(facetsOf(row));
    const items = row.operations ?? [];
    return {
        contract: "onboarding.status.v1",
        event_id: eventId,
        idempotency_key: row.idempotency_key,
        request_id: row.id,
        client_id: row.client_id,
        version: row.version,
        occurred_at: iso(occurredAt),
        signature: { state: row.signature_state, at: iso(row.signature_at) },
        payment: {
            state: row.payment_state,
            method: row.payment_method_type ?? null,
            last4: row.payment_last4 ?? null,
            at: iso(row.payment_at),
        },
        provisioning: {
            state: row.provisioning_state,
            kelevo_ref: row.kelevo_ref ?? null,
            at: iso(row.provisioning_at),
        },
        operations: {
            state: operationsState(items),
            items: items.map((i) => ({
                key: i.key,
                state: i.state,
                at: i.at ?? null,
            })),
        },
        readiness,
        blocked,
        documents: { signed_available: !!signedAvailable },
    };
}
