// Pure onboarding state rules (design §7). No I/O.

export const OPERATION_SLOTS = [
    "AUTHORITY_VERIFIED",
    "INSURANCE_COI",
    "W9",
    "FACTORING", // satisfied by FACTORING_NOA or NOT_FACTORING
    "CARRIER_PROFILE",
    "FLEET_MAPPING",
    // Staff-only: Iron Wing confirmed the carrier's load board seat(s) for the
    // assigned dispatcher (owner ruling 2026-11-19). Required for READY.
    "LOAD_BOARD_ACCESS",
];
export const LOAD_BOARDS = ["DAT_ONE", "TRUCKSTOP", "OTHER"];
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

/**
 * Marks one item RECEIVED (R15): the document arrived but is not yet checked.
 * Same slot rule as verify. Returns null when the slot is already VERIFIED
 * (RECEIVED never downgrades a verified item).
 */
export function markOperationItemReceived(
    items,
    key,
    { actor, note = null, at }
) {
    const slot = slotOf(key);
    if (!OPERATION_SLOTS.includes(slot))
        throw new Error("unknown_operation_item");
    if (items.some((i) => slotOf(i.key) === slot && i.state === "VERIFIED"))
        return null;
    return items.map((item) =>
        slotOf(item.key) === slot
            ? { key, state: "RECEIVED", at: at.toISOString(), actor, note }
            : item
    );
}

export function requestReupload(items, key, { actor, note, at }) {
    const reason = typeof note === "string" ? note.trim() : "";
    if (!reason || reason.length > 300)
        throw new Error("invalid_reupload_reason");
    const current = items.find((item) => slotOf(item.key) === slotOf(key));
    if (!current || !["RECEIVED", "VERIFIED"].includes(current.state))
        return null;
    return items.map((item) =>
        item === current
            ? {
                  ...item,
                  state: "REUPLOAD_REQUESTED",
                  actor,
                  at: at.toISOString(),
                  note: reason,
              }
            : item
    );
}

/**
 * Confirms the carrier's load board access: boards is a non-empty subset of
 * LOAD_BOARDS; OTHER needs a short note naming the board. Returns a new array.
 */
export function confirmLoadBoardAccess(
    items,
    { boards, note = null, actor, at }
) {
    const chosen = [...new Set(boards ?? [])];
    if (!chosen.length || chosen.some((b) => !LOAD_BOARDS.includes(b)))
        throw new Error("invalid_load_boards");
    const text = typeof note === "string" ? note.trim() : "";
    if (chosen.includes("OTHER") && !text)
        throw new Error("load_board_note_required");
    const previous = items.find((item) => item.key === "LOAD_BOARD_ACCESS");
    const entry = {
        key: "LOAD_BOARD_ACCESS",
        state: "VERIFIED",
        at: at.toISOString(),
        actor,
        note: text || null,
        boards: LOAD_BOARDS.filter((b) => chosen.includes(b)),
        // Keep what the carrier reported on the portal, for the record.
        ...(previous?.reported
            ? {
                  reported: previous.reported,
                  reported_note: previous.reported_note ?? null,
              }
            : {}),
    };
    return items.some((item) => item.key === "LOAD_BOARD_ACCESS")
        ? items.map((item) => (item.key === "LOAD_BOARD_ACCESS" ? entry : item))
        : [...items, entry];
}

/**
 * The carrier pressed "Added" for a board on the portal: LOAD_BOARD_ACCESS
 * becomes RECEIVED with the reported boards (accumulated). Staff still
 * confirm. Returns null once access is already confirmed (VERIFIED).
 */
export function reportLoadBoard(items, { board, note = null, at }) {
    if (!LOAD_BOARDS.includes(board)) throw new Error("invalid_load_boards");
    const text = typeof note === "string" ? note.trim().slice(0, 100) : "";
    if (board === "OTHER" && !text) throw new Error("load_board_note_required");
    const current = items.find((item) => item.key === "LOAD_BOARD_ACCESS");
    if (current?.state === "VERIFIED") return null;
    const reported = LOAD_BOARDS.filter(
        (b) => b === board || (current?.reported ?? []).includes(b)
    );
    const entry = {
        key: "LOAD_BOARD_ACCESS",
        state: "RECEIVED",
        at: at.toISOString(),
        actor: { type: "carrier" },
        note: current?.note ?? null,
        reported,
        reported_note:
            board === "OTHER" ? text : (current?.reported_note ?? null),
    };
    return current
        ? items.map((item) => (item === current ? entry : item))
        : [...items, entry];
}

export function unverifyOperationItem(items, key, { actor, at }) {
    const current = items.find((item) => slotOf(item.key) === slotOf(key));
    if (current?.state !== "VERIFIED") return null;
    if (current.key === "LOAD_BOARD_ACCESS")
        return items.map((item) =>
            item === current
                ? {
                      key: item.key,
                      state: "PENDING",
                      at: at.toISOString(),
                      actor,
                      note: null,
                  }
                : item
        );
    return items.map((item) =>
        item === current
            ? {
                  ...item,
                  state: "RECEIVED",
                  actor,
                  at: at.toISOString(),
                  note: null,
              }
            : item
    );
}

/** Carrier-facing slots (FLEET_MAPPING is internal), in email order. */
export const CARRIER_FACING_SLOTS = [
    "W9",
    "INSURANCE_COI",
    "AUTHORITY_VERIFIED",
    "FACTORING",
    "CARRIER_PROFILE",
];

/** Outstanding carrier-facing checklist slots. */
export const missingCarrierSlots = (items) =>
    CARRIER_FACING_SLOTS.filter(
        (slot) =>
            !(items ?? []).some(
                (i) =>
                    slotOf(i.key) === slot &&
                    ["RECEIVED", "VERIFIED"].includes(i.state)
            )
    );

// Every required slot present and VERIFIED. Requests created before load
// board tracking (no LOAD_BOARD_ACCESS item at all) keep their six slots.
// Every required slot present and VERIFIED. Requests created before load
// board tracking (no LOAD_BOARD_ACCESS item at all) keep their six slots.
// Portal onboardings (owner ruling 2026-11-19): factoring is optional, so
// the factoring slot and its items never count, whatever their state.
export const operationsState = (items, { portal = false } = {}) => {
    const counts = (item) => !(portal && slotOf(item.key) === "FACTORING");
    const list = (items ?? []).filter(counts);
    const required = OPERATION_SLOTS.filter(
        (slot) =>
            !(portal && slot === "FACTORING") &&
            (slot !== "LOAD_BOARD_ACCESS" ||
                list.some((i) => i.key === "LOAD_BOARD_ACCESS"))
    );
    return required.every((slot) =>
        list.some((i) => slotOf(i.key) === slot && i.state === "VERIFIED")
    ) && list.every((i) => i.state === "VERIFIED")
        ? "COMPLETE"
        : "PENDING";
};

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
    // R15: the combined completion email failed 3 times (or went stale).
    if (f.completionEmailCode) return block(f.completionEmailCode, "reconcile");
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
    operations: operationsState(row.operations ?? [], {
        portal: !!row.portal_flow,
    }),
    completionEmailCode: row.completion_email_code ?? null,
});

const iso = (date) => (date ? new Date(date).toISOString() : null);

/** Builds the full onboarding.status.v1 payload from a stored request row. */
export function buildStatus(
    row,
    {
        eventId,
        occurredAt,
        signedAvailable,
        uploaded = [],
        questionnaireSubmitted = false,
    }
) {
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
        signature: {
            state: row.signature_state,
            at: iso(row.signature_at),
            // R14 (additive): IRON_WING | CARRIER while SENT/VIEWED, else null.
            waiting_for: ["SENT", "VIEWED"].includes(row.signature_state)
                ? (row.signature_waiting_for ?? null)
                : null,
        },
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
            state: operationsState(items, { portal: !!row.portal_flow }),
            items: items.map((i) => ({
                key: i.key,
                state: i.state,
                at: i.at ?? null,
                ...(i.key === "LOAD_BOARD_ACCESS" && i.boards
                    ? { boards: i.boards, boards_note: i.note ?? null }
                    : {}),
                ...(i.key === "LOAD_BOARD_ACCESS" && i.reported
                    ? {
                          reported_boards: i.reported,
                          reported_note: i.reported_note ?? null,
                      }
                    : {}),
                ...(row.portal_flow
                    ? {
                          document:
                              uploaded.find(
                                  (document) => document.item_key === i.key
                              )?.summary ?? null,
                      }
                    : {}),
            })),
            // R15 (additive): documents email and reminders.
            documents_requested_at: iso(row.documents_requested_at),
            reminders_sent: row.reminders_sent ?? 0,
            reminders_paused: !!row.reminders_paused,
        },
        ...(row.portal_flow
            ? {
                  portal: {
                      flow: true,
                      invited_at: iso(row.portal_invited_at),
                      last_opened_at: iso(row.portal_last_opened_at),
                      questionnaire_submitted: questionnaireSubmitted,
                      // A closer's assignment; null means the configured default.
                      dispatcher: row.dispatcher_name
                          ? {
                                name: row.dispatcher_name,
                                email: row.dispatcher_email,
                                source: "ASSIGNED",
                            }
                          : null,
                  },
              }
            : {}),
        readiness,
        blocked,
        documents: { signed_available: !!signedAvailable },
    };
}
