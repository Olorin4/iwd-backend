import { PORTAL_REQUIRED_SLOTS } from "../portalEmails.js";
import { deriveReadiness, facetsOf, slotOf } from "../readiness.js";

// The portal timeline (owner-approved redesign 2026-11-19): four required
// steps counted in the header, plus the optional questionnaire. A step is
// "done" from the carrier's side; READY additionally needs Iron Wing's
// checks, which is why "allSet" exists.
const REQUIRED = ["sign", "payment", "documents", "loadBoard"];

const itemFor = (row, slot) =>
    (row.operations ?? []).find((entry) => slotOf(entry.key) === slot);

function doneOf(row) {
    return {
        sign: row.signature_state === "COMPLETED",
        payment: ["READY", "PENDING_VERIFICATION"].includes(row.payment_state),
        documents: PORTAL_REQUIRED_SLOTS.every((slot) =>
            ["RECEIVED", "VERIFIED"].includes(itemFor(row, slot)?.state)
        ),
        loadBoard: itemFor(row, "LOAD_BOARD_ACCESS")?.state === "VERIFIED",
    };
}

/**
 * Returns { doneCount, phase, steps }: steps in page order with state
 * done | current | upcoming (required) or optional (questionnaire); phase
 * closed | ready | allSet | working.
 */
export function portalSteps(row) {
    const done = doneOf(row);
    const doneCount = REQUIRED.filter((id) => done[id]).length;
    const phase = row.cancelled_at
        ? "closed"
        : deriveReadiness(facetsOf(row)).readiness === "READY"
          ? "ready"
          : doneCount === REQUIRED.length
            ? "allSet"
            : "working";
    const current =
        phase === "working" ? REQUIRED.find((id) => !done[id]) : undefined;
    return {
        doneCount,
        phase,
        steps: [
            ...REQUIRED.map((id) => ({
                id,
                state: done[id]
                    ? "done"
                    : id === current
                      ? "current"
                      : "upcoming",
            })),
            { id: "about", state: "optional" },
        ],
    };
}
