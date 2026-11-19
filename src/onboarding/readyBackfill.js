import { deriveReadiness, facetsOf } from "./readiness.js";
import { applyFacetChange, lockRequest } from "./store.js";

// Owner rulings 2026-11-19: factoring is optional for portal onboardings, and
// Kelevo set-up is no longer part of READY. An open request that is READY
// under the current rule but has no ready_at gets the READY side effects once
// (ready_at, purge date, status event, Client ACTIVE). No email is sent.
export async function readyAfterRuleChange(db, now = new Date()) {
    const candidates = await db.onboardingRequest.findMany({
        where: {
            ready_at: null,
            cancelled_at: null,
            purged_at: null,
        },
        select: { id: true },
    });
    let readied = 0;
    for (const { id } of candidates) {
        const done = await db.$transaction(async (tx) => {
            const row = await lockRequest(tx, id);
            if (
                !row ||
                row.ready_at ||
                row.cancelled_at ||
                row.purged_at ||
                deriveReadiness(facetsOf(row)).readiness !== "READY"
            )
                return false;
            const result = await applyFacetChange(tx, row, {}, now, {
                reevaluate: true,
            });
            return result.changed;
        });
        if (done) readied++;
    }
    return readied;
}
