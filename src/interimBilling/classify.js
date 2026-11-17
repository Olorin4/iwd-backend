// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { feeCents } from "./money.js";

export function classifyLoad(load, ctx) {
    const cancelled = load.status === "CANCELED";
    if (!cancelled && !["DELIVERED", "PAID"].includes(load.status)) return null;
    const occurredAt = cancelled
        ? load.canceledAt
        : (load.deliveredAt ?? load.deliveryEnd);
    if (!occurredAt || occurredAt < ctx.startDate || occurredAt >= ctx.runEnd)
        return null;
    const driver = ctx.carrierByDriver.get(load.driverId);
    const truck = ctx.carrierByTruck.get(load.truckId);
    const conflict = driver && truck && driver.id !== truck.id;
    const carrier = conflict ? null : (driver ?? truck);
    const linehaul = load.enteredLinehaulCents;
    const reason = conflict
        ? "carrier_conflict"
        : !carrier
          ? "no_carrier"
          : load.currency !== "USD"
            ? "non_usd"
            : cancelled
              ? "cancelled_by_whom"
              : !(linehaul > 0)
                ? "needs_linehaul"
                : null;
    return {
        kelevoLoadId: load.id,
        loadNumber: load.loadNumber,
        kind: cancelled ? "CARRIER_CANCELLED" : "DELIVERED",
        carrierId: carrier?.id ?? null,
        status: reason ? "held" : "ready",
        holdReason: reason,
        allInRateCents: load.rateCents,
        linehaulCents: linehaul,
        feeBp: carrier?.feeBp ?? null,
        feeCents:
            carrier && linehaul > 0 ? feeCents(linehaul, carrier.feeBp) : null,
        occurredAt,
    };
}
