// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { classifyLoad } from "../../src/interimBilling/classify.js";
const date = new Date("2026-11-18T18:00:00Z");
const load = {
    id: 1,
    loadNumber: 123,
    status: "DELIVERED",
    driverId: 7,
    truckId: 8,
    rateCents: 280000,
    currency: "USD",
    enteredLinehaulCents: 240000,
    deliveredAt: date,
    deliveryEnd: date,
    canceledAt: date,
};
const ctx = {
    carrierByDriver: new Map([[7, { id: 2, feeBp: 500 }]]),
    carrierByTruck: new Map(),
    startDate: new Date("2026-11-01Z"),
    runEnd: new Date("2026-11-23Z"),
};
const classify = (patch = {}, context = {}) =>
    classifyLoad({ ...load, ...patch }, { ...ctx, ...context });
it("calculates a delivered fee from entered linehaul", () =>
    expect(classify()).toMatchObject({
        status: "ready",
        carrierId: 2,
        feeCents: 12000,
        kind: "DELIVERED",
    }));
it("holds missing linehaul and preserves all-in reference", () =>
    expect(classify({ enteredLinehaulCents: null })).toMatchObject({
        status: "held",
        holdReason: "needs_linehaul",
        allInRateCents: 280000,
    }));
it("treats PAID as delivered and falls back to deliveryEnd", () => {
    expect(classify({ status: "PAID", deliveredAt: null }).occurredAt).toEqual(
        date
    );
    expect(classify({ deliveredAt: null, deliveryEnd: null })).toBeNull();
});
it("excludes dates outside the half-open window and other statuses", () => {
    for (const patch of [
        { deliveredAt: ctx.runEnd },
        { deliveredAt: new Date("2026-10-31Z") },
        { status: "BOOKED" },
    ])
        expect(classify(patch)).toBeNull();
});
it("holds missing or conflicting carrier mappings", () => {
    expect(classify({ driverId: null })).toMatchObject({
        holdReason: "no_carrier",
    });
    expect(
        classify({}, { carrierByTruck: new Map([[8, { id: 3, feeBp: 1000 }]]) })
    ).toMatchObject({ holdReason: "carrier_conflict", carrierId: null });
});
it("uses a truck mapping when the driver is unmapped", () =>
    expect(
        classify(
            { driverId: null },
            { carrierByTruck: new Map([[8, { id: 3, feeBp: 1000 }]]) }
        )
    ).toMatchObject({ carrierId: 3, feeCents: 24000 }));
it("holds non-USD", () =>
    expect(classify({ currency: "CAD" })).toMatchObject({
        status: "held",
        holdReason: "non_usd",
    }));
it("always holds cancellations for a decision and excludes undated cancellations", () => {
    expect(classify({ status: "CANCELED" })).toMatchObject({
        kind: "CARRIER_CANCELLED",
        status: "held",
        holdReason: "cancelled_by_whom",
    });
    expect(classify({ status: "CANCELED", canceledAt: null })).toBeNull();
});
