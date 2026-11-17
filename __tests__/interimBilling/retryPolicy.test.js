// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { nextStep } from "../../src/interimBilling/retryPolicy.js";
const firstFailureAt = new Date("2026-11-25T15:00:00Z"),
    zone = "America/Chicago";
const step = (round, backup, hasBackup = true) =>
    nextStep(
        { round, triedBackupThisRound: backup, hasBackup, firstFailureAt },
        firstFailureAt,
        zone
    );
it("tries backup now then primary at +1 and +3 business days, skipping Thanksgiving and weekend", () => {
    expect(step(0, false)).toMatchObject({
        action: "try",
        method: "backup",
        at: firstFailureAt,
        round: 0,
    });
    expect(step(0, true)).toEqual({
        action: "try",
        method: "primary",
        at: new Date("2026-11-27T15:00:00Z"),
        round: 1,
    });
    expect(step(1, true)).toEqual({
        action: "try",
        method: "primary",
        at: new Date("2026-12-01T15:00:00Z"),
        round: 2,
    });
    expect(step(2, false)).toMatchObject({ method: "backup", round: 2 });
    expect(step(2, true)).toEqual({ action: "give_up" });
});
it("skips backup rounds when none is saved", () => {
    expect(step(0, false, false)).toMatchObject({
        method: "primary",
        round: 1,
    });
    expect(step(1, false, false)).toMatchObject({
        method: "primary",
        round: 2,
    });
    expect(step(2, false, false)).toEqual({ action: "give_up" });
});
