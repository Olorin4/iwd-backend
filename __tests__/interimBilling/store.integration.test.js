// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { prisma } from "../../src/prismaClient";
import * as store from "../../src/interimBilling/store";

const TABLES = [
    "interim_billing_line",
    "interim_billing_invoice",
    "interim_billing_stripe_event",
    "interim_billing_carrier_asset",
    "interim_billing_run",
    "interim_billing_carrier",
];

async function clean() {
    for (const table of TABLES) {
        await prisma.$executeRawUnsafe(`DELETE FROM ${table}`);
    }
}

const RUN_END = new Date("2026-11-16T06:00:00Z");

function lineInsert(runId, overrides = {}) {
    return {
        run_id: runId,
        kelevo_load_id: 1,
        load_number: 1234,
        kind: "DELIVERED",
        carrier_id: null,
        all_in_rate_cents: 250000,
        linehaul_cents: null,
        fee_bp: null,
        fee_cents: null,
        hold_reason: "needs_linehaul",
        status: "held",
        occurred_at: new Date("2026-11-12T15:00:00Z"),
        ...overrides,
    };
}

beforeEach(clean);
afterAll(clean);

describe("runs", () => {
    it("claimRun creates a run once and returns the same run afterwards", async () => {
        const first = await store.claimRun(RUN_END);
        const second = await store.claimRun(RUN_END);
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.run.id).toBe(first.run.id);
        expect(first.run.status).toBe("building");
    });

    it("claimRun called concurrently creates exactly one run", async () => {
        const results = await Promise.all([
            store.claimRun(RUN_END),
            store.claimRun(RUN_END),
            store.claimRun(RUN_END),
        ]);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    });

    it("transitionRun succeeds once and fails when the from-status no longer matches", async () => {
        const { run } = await store.claimRun(RUN_END);
        expect(
            await store.transitionRun(run.id, ["building"], "awaiting_approval")
        ).toBe(true);
        expect(
            await store.transitionRun(run.id, ["building"], "awaiting_approval")
        ).toBe(false);
    });

    it("two concurrent transitionRun calls yield exactly one true", async () => {
        const { run } = await store.claimRun(RUN_END);
        const results = await Promise.all([
            store.transitionRun(run.id, ["building"], "awaiting_approval"),
            store.transitionRun(run.id, ["building"], "awaiting_approval"),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("transitionRun stores extra data such as the approver", async () => {
        const { run } = await store.claimRun(RUN_END);
        await store.transitionRun(run.id, ["building"], "approved", {
            approved_by: "admin-token",
            approved_invoice_count: 2,
            approved_total_cents: 5000,
        });
        const row = await prisma.interimBillingRun.findUnique({
            where: { id: run.id },
        });
        expect(row.approved_by).toBe("admin-token");
        expect(row.approved_total_cents).toBe(5000);
    });
});

describe("lines", () => {
    it("insertLinesIfAbsent never inserts the same (load, kind) twice", async () => {
        const { run } = await store.claimRun(RUN_END);
        expect(await store.insertLinesIfAbsent([lineInsert(run.id)])).toBe(1);
        expect(await store.insertLinesIfAbsent([lineInsert(run.id)])).toBe(0);
        expect(
            await store.insertLinesIfAbsent([
                lineInsert(run.id),
                lineInsert(run.id, { kind: "CARRIER_CANCELLED" }),
            ])
        ).toBe(1);
        expect(await prisma.interimBillingLine.count()).toBe(2);
    });

    it("updateLineIf changes a line only from the expected status", async () => {
        const { run } = await store.claimRun(RUN_END);
        await store.insertLinesIfAbsent([lineInsert(run.id)]);
        const [line] = await store.listLinesForRun(run.id);
        expect(
            await store.updateLineIf(line.id, ["held"], {
                status: "ready",
                linehaul_cents: 240000,
            })
        ).toBe(true);
        expect(
            await store.updateLineIf(line.id, ["held"], { status: "skipped" })
        ).toBe(false);
        expect((await store.getLine(line.id)).status).toBe("ready");
    });

    it("listReadyLinesWithoutInvoice returns only ready lines with no invoice", async () => {
        const { run } = await store.claimRun(RUN_END);
        await store.insertLinesIfAbsent([
            lineInsert(run.id, { kelevo_load_id: 1, status: "ready" }),
            lineInsert(run.id, { kelevo_load_id: 2, status: "held" }),
        ]);
        const ready = await store.listReadyLinesWithoutInvoice();
        expect(ready.map((l) => l.kelevo_load_id)).toEqual([1]);
    });
});

describe("carriers", () => {
    const carrierInput = (overrides = {}) => ({
        legal_name: "Test Trucking LLC",
        mc: "123456",
        usdot: "654321",
        email: "carrier@example.com",
        fee_bp: 500,
        driverIds: [11],
        truckIds: [21],
        ...overrides,
    });

    it("createCarrier stores the assets and findCarrierByAsset finds it", async () => {
        const carrier = await store.createCarrier(carrierInput());
        expect((await store.findCarrierByAsset("DRIVER", 11)).id).toBe(
            carrier.id
        );
        expect((await store.findCarrierByAsset("TRUCK", 21)).id).toBe(
            carrier.id
        );
        expect(await store.findCarrierByAsset("DRIVER", 99)).toBeNull();
    });

    it("an asset cannot belong to two carriers", async () => {
        await store.createCarrier(carrierInput());
        await expect(
            store.createCarrier(
                carrierInput({ legal_name: "Other LLC", truckIds: [] })
            )
        ).rejects.toThrow();
        expect(await prisma.interimBillingCarrier.count()).toBe(1);
    });

    it("setPaymentMethod stores the id, brand and last four for the role", async () => {
        const carrier = await store.createCarrier(carrierInput());
        await store.setPaymentMethod(carrier.id, "primary", {
            pmId: "pm_1",
            brand: "visa",
            last4: "4242",
        });
        await store.setPaymentMethod(carrier.id, "backup", {
            pmId: "pm_2",
            brand: "us_bank_account",
            last4: "6789",
        });
        const row = await store.getCarrier(carrier.id);
        expect(row.primary_pm_id).toBe("pm_1");
        expect(row.primary_pm_last4).toBe("4242");
        expect(row.backup_pm_id).toBe("pm_2");
    });
});

describe("invoices and events", () => {
    async function seedInvoice(overrides = {}) {
        const carrier = await store.createCarrier({
            legal_name: "Inv Trucking",
            email: "inv@example.com",
            fee_bp: 500,
            driverIds: [],
            truckIds: [],
        });
        const { run } = await store.claimRun(RUN_END);
        return store.createInvoiceRow({
            run_id: run.id,
            carrier_id: carrier.id,
            total_cents: 12000,
            ...overrides,
        });
    }

    it("createInvoiceRow is idempotent per (run, carrier)", async () => {
        const first = await seedInvoice();
        const again = await store.createInvoiceRow({
            run_id: first.run_id,
            carrier_id: first.carrier_id,
            total_cents: 12000,
        });
        expect(again.id).toBe(first.id);
        expect(await prisma.interimBillingInvoice.count()).toBe(1);
    });

    it("transitionInvoice is atomic like transitionRun", async () => {
        const invoice = await seedInvoice();
        const results = await Promise.all([
            store.transitionInvoice(invoice.id, ["draft"], "finalizing"),
            store.transitionInvoice(invoice.id, ["draft"], "finalizing"),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("listDueRetries returns only scheduled invoices whose time has come", async () => {
        const due = await seedInvoice();
        await store.transitionInvoice(due.id, ["draft"], "retry_scheduled", {
            next_attempt_at: new Date("2026-11-23T16:00:00Z"),
        });
        const rows = await store.listDueRetries(
            new Date("2026-11-22T16:00:00Z")
        );
        expect(rows).toHaveLength(0);
        const later = await store.listDueRetries(
            new Date("2026-11-23T16:00:00Z")
        );
        expect(later.map((r) => r.id)).toEqual([due.id]);
    });

    it("recordStripeEvent returns true the first time and false after", async () => {
        expect(await store.recordStripeEvent("evt_1", "invoice.paid")).toBe(
            true
        );
        expect(await store.recordStripeEvent("evt_1", "invoice.paid")).toBe(
            false
        );
    });
});

it("serializes billing work across database sessions and releases after failure", async () => {
    await expect(
        store.withBillingLock(async () => {
            await expect(
                store.withBillingLock(async () => {})
            ).rejects.toMatchObject({ code: "billing_busy" });
            throw new Error("simulated_crash");
        })
    ).rejects.toThrow("simulated_crash");
    await expect(store.withBillingLock(async () => "released")).resolves.toBe(
        "released"
    );
});

it("rolls event recording and its effect back together", async () => {
    const eventId = `evt_transaction_${Date.now()}`;
    await expect(
        store.withTransaction(async () => {
            await store.recordStripeEvent(eventId, "test");
            throw new Error("rollback");
        })
    ).rejects.toThrow("rollback");
    await store.withTransaction(async () => {
        expect(await store.recordStripeEvent(eventId, "test")).toBe(true);
    });
    await store.withTransaction(async () => {
        expect(await store.recordStripeEvent(eventId, "test")).toBe(false);
    });
});
