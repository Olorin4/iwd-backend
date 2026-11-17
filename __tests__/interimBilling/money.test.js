// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    toCents,
    feeCents,
    formatUsd,
    describeLine,
    MIN_CHARGE_CENTS,
} from "../../src/interimBilling/money";

describe("toCents", () => {
    it("parses decimal strings exactly", () => {
        expect(toCents("2400.00")).toBe(240000);
        expect(toCents("0.07")).toBe(7);
        expect(toCents("12.5")).toBe(1250);
        expect(toCents("7")).toBe(700);
    });

    it("accepts numbers that print as at most two decimals", () => {
        expect(toCents(2400)).toBe(240000);
        expect(toCents(12.5)).toBe(1250);
        expect(toCents(0.07)).toBe(7);
    });

    it("returns null for missing values", () => {
        expect(toCents(null)).toBeNull();
        expect(toCents(undefined)).toBeNull();
        expect(toCents("")).toBeNull();
    });

    it("throws on anything that is not a plain non-negative amount with at most two decimals", () => {
        for (const bad of [
            "1.234",
            "-1",
            "abc",
            NaN,
            Infinity,
            "1e5",
            "1,000",
            " 5",
        ]) {
            expect(() => toCents(bad)).toThrow();
        }
    });
});

describe("feeCents", () => {
    it("works in integer cents and basis points, rounding half up", () => {
        expect(feeCents(240000, 500)).toBe(12000);
        expect(feeCents(12345, 500)).toBe(617);
        expect(feeCents(10, 500)).toBe(1);
        expect(feeCents(9, 500)).toBe(0);
        expect(feeCents(100, 1000)).toBe(10);
    });
});

describe("formatUsd", () => {
    it("formats cents as dollars", () => {
        expect(formatUsd(240000)).toBe("$2,400.00");
        expect(formatUsd(5)).toBe("$0.05");
        expect(formatUsd(0)).toBe("$0.00");
        expect(formatUsd(123456789)).toBe("$1,234,567.89");
    });
});

describe("describeLine", () => {
    const base = {
        kind: "DELIVERED",
        loadNumber: 1234,
        occurredAt: new Date("2026-11-18T18:00:00Z"),
        linehaulCents: 240000,
        feeBp: 500,
        feeCents: 12000,
    };

    it("describes a delivered load", () => {
        expect(describeLine(base, "America/Chicago")).toBe(
            "Load 1234, delivered Wed Nov 18: linehaul $2,400.00 x 5% = $120.00"
        );
    });

    it("shows fractional percentages", () => {
        expect(
            describeLine(
                { ...base, feeBp: 750, feeCents: 18000 },
                "America/Chicago"
            )
        ).toContain("x 7.5% =");
    });

    it("says cancelled for a carrier-cancelled load", () => {
        expect(
            describeLine(
                { ...base, kind: "CARRIER_CANCELLED" },
                "America/Chicago"
            )
        ).toContain("cancelled Wed Nov 18");
    });

    it("uses the local date, not the UTC date", () => {
        expect(
            describeLine(
                { ...base, occurredAt: new Date("2026-11-19T02:00:00Z") },
                "America/Chicago"
            )
        ).toContain("Wed Nov 18");
    });

    it("falls back to the id when the load has no number", () => {
        expect(
            describeLine(
                { ...base, loadNumber: null, kelevoLoadId: 77 },
                "America/Chicago"
            )
        ).toContain("Load id 77,");
    });
});

describe("MIN_CHARGE_CENTS", () => {
    it("is Stripe's 50 cent minimum", () => {
        expect(MIN_CHARGE_CENTS).toBe(50);
    });
});
