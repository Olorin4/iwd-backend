import { deriveReadiness, facetsOf } from "./readiness.js";
import { applyFacetChange, lockRequest } from "./store.js";

// Owner ruling 2026-11-19: factoring is optional for portal onboardings. A
// portal request whose only gap was factoring is READY under the new rule;
// this applies the READY side effects once (ready_at, purge date, status
// event, Client ACTIVE). No email is sent. Email-flow requests are untouched.
export async function readyAfterFactoringChange(db, now = new Date()) {
    const candidates = await db.onboardingRequest.findMany({
        where: {
            portal_flow: true,
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
                !row?.portal_flow ||
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
