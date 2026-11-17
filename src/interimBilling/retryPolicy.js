// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { addBusinessDays } from "./schedule.js";
export function nextStep(
    { round, triedBackupThisRound, hasBackup, firstFailureAt },
    now,
    timeZone
) {
    if (hasBackup && !triedBackupThisRound)
        return { action: "try", method: "backup", at: now, round };
    if (round >= 2) return { action: "give_up" };
    return {
        action: "try",
        method: "primary",
        at: addBusinessDays(firstFailureAt, round === 0 ? 1 : 3, timeZone),
        round: round + 1,
    };
}
