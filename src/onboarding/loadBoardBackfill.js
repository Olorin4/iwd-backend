import { deriveReadiness, facetsOf } from "./readiness.js";
import { applyFacetChange, lockRequest } from "./store.js";

// Load board tracking (owner ruling 2026-11-19) adds LOAD_BOARD_ACCESS to
// the checklist. Requests still in progress get it (PENDING, with a status
// event so Outreach shows it); READY, cancelled or purged ones keep their
// original six items. Idempotent; run once when the workers start.
export async function addLoadBoardItem(db, now = new Date()) {
    const candidates = await db.onboardingRequest.findMany({
        where: { cancelled_at: null, purged_at: null, ready_at: null },
        select: { id: true },
    });
    let added = 0;
    for (const { id } of candidates) {
        const changed = await db.$transaction(async (tx) => {
            const row = await lockRequest(tx, id);
            if (
                !row ||
                row.cancelled_at ||
                row.purged_at ||
                row.operations.some((i) => i.key === "LOAD_BOARD_ACCESS") ||
                deriveReadiness(facetsOf(row)).readiness === "READY"
            )
                return false;
            await applyFacetChange(
                tx,
                row,
                {
                    operations: [
                        ...row.operations,
                        {
                            key: "LOAD_BOARD_ACCESS",
                            state: "PENDING",
                            at: null,
                            actor: null,
                            note: null,
                        },
                    ],
                },
                now
            );
            return true;
        });
        if (changed) added++;
    }
    return added;
}
