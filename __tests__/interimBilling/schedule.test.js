// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    runEndUtc,
    addBusinessDays,
    isRunDue,
    US_FEDERAL_HOLIDAYS,
} from "../../src/interimBilling/schedule";

const CHICAGO = "America/Chicago";
const iso = (date) => date.toISOString().replace(".000Z", "Z");

describe("runEndUtc", () => {
    it("is the latest local Monday 00:00 at or before now", () => {
        expect(iso(runEndUtc(new Date("2026-11-20T11:00:00Z"), CHICAGO))).toBe(
            "2026-11-16T06:00:00Z"
        );
    });

    it("handles the week that contained the fall-back Sunday (2026-11-01)", () => {
        // Sunday evening local: the run end is still the Monday before the
        // fall-back, at CDT (UTC-5).
        expect(iso(runEndUtc(new Date("2026-11-02T03:00:00Z"), CHICAGO))).toBe(
            "2026-10-26T05:00:00Z"
        );
    });

    it("returns Monday 00:00 itself when now is exactly that instant", () => {
        expect(iso(runEndUtc(new Date("2026-11-02T06:00:00Z"), CHICAGO))).toBe(
            "2026-11-02T06:00:00Z"
        );
    });

    it("handles the spring-forward week (2027-03-14)", () => {
        expect(iso(runEndUtc(new Date("2027-03-17T12:00:00Z"), CHICAGO))).toBe(
            "2027-03-15T05:00:00Z"
        );
    });

    it("uses the zone it is given", () => {
        expect(
            iso(runEndUtc(new Date("2026-11-20T11:00:00Z"), "America/New_York"))
        ).toBe("2026-11-16T05:00:00Z");
    });
});

describe("addBusinessDays", () => {
    it("moves from Friday to Monday for one business day", () => {
        expect(
            iso(addBusinessDays(new Date("2026-11-20T16:00:00Z"), 1, CHICAGO))
        ).toBe("2026-11-23T16:00:00Z");
    });

    it("skips Thanksgiving (2026-11-26) when adding three business days", () => {
        expect(
            iso(addBusinessDays(new Date("2026-11-23T16:00:00Z"), 3, CHICAGO))
        ).toBe("2026-11-27T16:00:00Z");
    });

    it("moves a Saturday forward to Monday for one business day", () => {
        expect(
            iso(addBusinessDays(new Date("2026-11-21T16:00:00Z"), 1, CHICAGO))
        ).toBe("2026-11-23T16:00:00Z");
    });

    it("keeps the local clock time across a daylight saving change", () => {
        // 2026-10-30 (Fri) 10:00 CDT + 1 business day = Mon 2026-11-02 10:00 CST
        expect(
            iso(addBusinessDays(new Date("2026-10-30T15:00:00Z"), 1, CHICAGO))
        ).toBe("2026-11-02T16:00:00Z");
    });

    it("returns the same instant for zero days", () => {
        expect(
            iso(addBusinessDays(new Date("2026-11-20T16:00:00Z"), 0, CHICAGO))
        ).toBe("2026-11-20T16:00:00Z");
    });
});

describe("isRunDue", () => {
    it("is true on Friday at or after the run hour (local)", () => {
        expect(isRunDue(new Date("2026-11-20T12:00:00Z"), CHICAGO, 6)).toBe(
            true
        );
        expect(isRunDue(new Date("2026-11-20T23:00:00Z"), CHICAGO, 6)).toBe(
            true
        );
    });

    it("is false on Friday before the run hour", () => {
        expect(isRunDue(new Date("2026-11-20T10:00:00Z"), CHICAGO, 6)).toBe(
            false
        );
    });

    it("is false on other days", () => {
        expect(isRunDue(new Date("2026-11-19T15:00:00Z"), CHICAGO, 6)).toBe(
            false
        );
        expect(isRunDue(new Date("2026-11-21T15:00:00Z"), CHICAGO, 6)).toBe(
            false
        );
    });
});

describe("US_FEDERAL_HOLIDAYS", () => {
    it("lists 2026 and 2027 including observed dates", () => {
        for (const day of [
            "2026-07-03",
            "2026-11-26",
            "2026-12-25",
            "2027-06-18",
            "2027-07-05",
            "2027-12-24",
        ]) {
            expect(US_FEDERAL_HOLIDAYS.has(day)).toBe(true);
        }
        expect(US_FEDERAL_HOLIDAYS.has("2026-11-27")).toBe(false);
    });
});
