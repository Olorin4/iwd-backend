// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    startRun,
    setLinehaul,
    decideCancelled,
    approveRun,
    StaleApprovalError,
} from "../../src/interimBilling/runService.js";
import { fakeStore } from "./fakeStore.js";
let deps, loads, remote;
const now = new Date("2026-11-20T15:00:00Z");
const load = (id, patch = {}) => ({
    id,
    loadNumber: 100 + id,
    status: "DELIVERED",
    driverId: 7,
    truckId: null,
    rateCents: 280000,
    enteredLinehaulCents: 240000,
    currency: "USD",
    deliveredAt: new Date("2026-11-12T18:00:00Z"),
    ...patch,
});
beforeEach(() => {
    loads = [
        load(1),
        load(2, { enteredLinehaulCents: null }),
        load(3, { status: "CANCELED", canceledAt: null }),
    ];
    remote = [];
    deps = {
        store: fakeStore(),
        config: {
            timezone: "America/Chicago",
            startDate: new Date("2026-11-01Z"),
            adminEmail: "admin@example.com",
        },
        fetchLoads: jest.fn(async () => loads),
        sendEmail: jest.fn(),
        stripe: {
            listInvoicesForRun: jest.fn(async () => remote),
            createDraftInvoice: jest.fn(async () => {
                remote.push({ id: "in_1", status: "draft", itemLineIds: [] });
                return { invoiceId: "in_1" };
            }),
            addInvoiceItem: jest.fn(async ({ lineId }) => {
                remote[0].itemLineIds.push(lineId);
                return { itemId: `ii_${lineId}` };
            }),
        },
    };
});
it("builds drafts, lists held reasons, reports undated cancellations and awaits approval", async () => {
    const summary = await startRun({ now }, deps);
    expect(summary).toMatchObject({
        totalCents: 12000,
        canceledWithoutDate: 1,
        invoices: [{ carrierId: 1, lineCount: 1, totalCents: 12000 }],
        held: [{ reason: "needs_linehaul", allInRateCents: 280000 }],
    });
    expect(deps.store.runs[0].status).toBe("awaiting_approval");
    expect(deps.sendEmail.mock.calls[0][0].text).toContain("needs_linehaul");
    expect(deps.stripe.addInvoiceItem.mock.calls[0][0].description).toBe(
        "Load 101, delivered Thu Nov 12: linehaul $2,400.00 x 5% = $120.00"
    );
});
it("dry run has the same totals but no writes, Stripe calls or mail", async () => {
    const dry = await startRun({ now, dryRun: true }, deps);
    expect(dry.runId).toBeNull();
    expect(deps.store.lines).toHaveLength(0);
    expect(deps.store.runs).toHaveLength(0);
    expect(deps.sendEmail).not.toHaveBeenCalled();
    for (const fn of Object.values(deps.stripe))
        expect(fn).not.toHaveBeenCalled();
    const real = await startRun({ now }, deps);
    expect(real.totalCents).toBe(dry.totalCents);
    expect(real.invoices).toEqual(dry.invoices);
});
it("does not invoice an overlapping load twice", async () => {
    await startRun({ now }, deps);
    await startRun({ now: new Date("2026-11-27Z") }, deps);
    expect(deps.stripe.createDraftInvoice).toHaveBeenCalledTimes(1);
    expect(deps.stripe.addInvoiceItem).toHaveBeenCalledTimes(1);
});
it("recovers a draft or item written to Stripe before the database write", async () => {
    const original = deps.store.transitionInvoice;
    deps.store.transitionInvoice = jest.fn(async (...args) => {
        if (args[3]?.stripe_invoice_id) {
            deps.store.transitionInvoice = original;
            throw new Error("crash");
        }
        return original(...args);
    });
    await expect(startRun({ now }, deps)).rejects.toThrow("crash");
    await startRun({ now }, deps);
    expect(deps.stripe.createDraftInvoice).toHaveBeenCalledTimes(1);
    deps.store.runs[0].status = "building";
    deps.store.lines[0].stripe_invoice_item_id = null;
    await startRun({ now }, deps);
    expect(deps.stripe.addInvoiceItem).toHaveBeenCalledTimes(1);
});
it("holds cancellations until decided, and requires linehaul after a charge decision", async () => {
    loads = [
        load(4, { status: "CANCELED", canceledAt: new Date("2026-11-12Z") }),
        load(5, {
            status: "CANCELED",
            canceledAt: new Date("2026-11-12Z"),
            enteredLinehaulCents: null,
        }),
        load(6, { status: "CANCELED", canceledAt: new Date("2026-11-12Z") }),
    ];
    await startRun({ now }, deps);
    expect(deps.store.lines.every((l) => l.status === "held")).toBe(true);
    await decideCancelled(1, true, deps);
    await decideCancelled(2, true, deps);
    await decideCancelled(3, false, deps);
    expect(deps.store.lines.map((l) => [l.status, l.hold_reason])).toEqual([
        ["ready", null],
        ["held", "needs_linehaul"],
        ["skipped", null],
    ]);
    await setLinehaul(2, "2400.00", "confirmed", deps);
    expect(deps.store.lines[1].status).toBe("ready");
});
it("requires positive linehaul and a note, without bypassing a cancellation decision", async () => {
    loads = [
        load(1, { enteredLinehaulCents: null }),
        load(2, {
            status: "CANCELED",
            canceledAt: new Date("2026-11-12Z"),
            enteredLinehaulCents: null,
        }),
    ];
    await startRun({ now }, deps);
    for (const [amount, note] of [
        ["0", "note"],
        ["-1", "note"],
        ["abc", "note"],
        ["2", ""],
    ])
        await expect(setLinehaul(1, amount, note, deps)).rejects.toThrow();
    await setLinehaul(1, "2400.00", "confirmed", deps);
    expect(deps.store.lines[0]).toMatchObject({
        status: "ready",
        fee_cents: 12000,
        linehaul_note: "confirmed",
    });
    await setLinehaul(2, "2400.00", "confirmed", deps);
    expect(deps.store.lines[1].hold_reason).toBe("cancelled_by_whom");
});
it("carries a subminimum invoice into the next run's aggregate", async () => {
    loads = [load(1, { enteredLinehaulCents: 500 })];
    expect((await startRun({ now }, deps)).invoices).toHaveLength(0);
    expect(deps.store.lines[0].hold_reason).toBe("below_minimum");
    loads.push(load(2, { enteredLinehaulCents: 500 }));
    expect(
        (await startRun({ now: new Date("2026-11-27Z") }, deps)).totalCents
    ).toBe(50);
    expect(deps.stripe.addInvoiceItem).toHaveBeenCalledTimes(2);
});
it("refuses stale or repeated approval and freezes the approved totals", async () => {
    const summary = await startRun({ now }, deps);
    for (const expected of [
        { invoiceCount: 2, totalCents: 12000 },
        { invoiceCount: 1, totalCents: 1 },
    ])
        await expect(
            approveRun(summary.runId, expected, "admin token", deps)
        ).rejects.toBeInstanceOf(StaleApprovalError);
    expect(deps.store.runs[0].status).toBe("awaiting_approval");
    await approveRun(
        summary.runId,
        { invoiceCount: 1, totalCents: 12000 },
        "admin token",
        deps
    );
    expect(deps.store.runs[0].status).toBe("approved");
    await expect(
        approveRun(
            summary.runId,
            { invoiceCount: 1, totalCents: 12000 },
            "admin token",
            deps
        )
    ).rejects.toBeInstanceOf(StaleApprovalError);
});
