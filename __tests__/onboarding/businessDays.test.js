import {
    addBusinessDays,
    reminderDueAt,
} from "../../src/onboarding/businessDays";

const iso = (d) => d.toISOString();

describe("addBusinessDays (Mon–Fri, America/New_York)", () => {
    it.each([
        // [start, n, expected, note]
        [
            "2026-11-16T15:00:00.000Z",
            3,
            "2026-11-19T15:00:00.000Z",
            "Mon → Thu",
        ],
        [
            "2026-11-19T15:00:00.000Z",
            3,
            "2026-11-24T15:00:00.000Z",
            "Thu → Tue over a weekend",
        ],
        [
            "2026-11-20T15:00:00.000Z",
            7,
            "2026-12-01T15:00:00.000Z",
            "Fri + 7 → Tue a week later",
        ],
        [
            "2026-11-21T15:00:00.000Z",
            3,
            "2026-11-25T15:00:00.000Z",
            "Sat counts from Mon → Wed",
        ],
        [
            "2026-11-22T15:00:00.000Z",
            1,
            "2026-11-23T15:00:00.000Z",
            "Sun + 1 → Mon",
        ],
        // 22:00 Thursday in New York is already Friday in UTC.
        [
            "2026-11-20T03:00:00.000Z",
            3,
            "2026-11-25T03:00:00.000Z",
            "NY Thu 22:00 → Tue 22:00",
        ],
        // DST starts Sun 2026-03-08: 10:00 EST → 10:00 EDT (one hour less UTC).
        [
            "2026-03-05T15:00:00.000Z",
            3,
            "2026-03-10T14:00:00.000Z",
            "across spring forward",
        ],
        // DST ends Sun 2026-11-01: 10:00 EDT → 10:00 EST.
        [
            "2026-10-29T14:00:00.000Z",
            3,
            "2026-11-03T15:00:00.000Z",
            "across fall back",
        ],
        [
            "2026-10-29T14:00:00.000Z",
            7,
            "2026-11-09T15:00:00.000Z",
            "7 across fall back",
        ],
        // 01:30 EDT on Fri before fall back → 01:30 EST on Mon.
        [
            "2026-10-30T05:30:00.000Z",
            1,
            "2026-11-02T06:30:00.000Z",
            "early hours across fall back",
        ],
        [
            "2026-12-31T20:00:00.000Z",
            3,
            "2027-01-05T20:00:00.000Z",
            "over New Year (no holiday calendar)",
        ],
    ])("%s + %i → %s (%s)", (start, n, expected) => {
        expect(iso(addBusinessDays(new Date(start), n))).toBe(expected);
    });

    it("keeps milliseconds and returns the start for 0", () => {
        const start = new Date("2026-11-16T15:00:00.123Z");
        expect(iso(addBusinessDays(start, 0))).toBe(iso(start));
        expect(iso(addBusinessDays(start, 1))).toBe("2026-11-17T15:00:00.123Z");
    });

    it("rejects invalid counts", () => {
        expect(() => addBusinessDays(new Date(), -1)).toThrow();
        expect(() => addBusinessDays(new Date(), 1.5)).toThrow();
    });
});

describe("reminderDueAt", () => {
    const start = new Date("2026-11-16T15:00:00.000Z"); // Mon 10:00 EST
    it("reminder 1 after 3 business days, reminder 2 after 7, none after", () => {
        expect(iso(reminderDueAt(start, 1))).toBe("2026-11-19T15:00:00.000Z");
        expect(iso(reminderDueAt(start, 2))).toBe("2026-11-25T15:00:00.000Z");
        expect(reminderDueAt(start, 3)).toBeNull();
        expect(reminderDueAt(null, 1)).toBeNull();
    });
});
