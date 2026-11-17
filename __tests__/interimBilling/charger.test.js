// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    chargeApprovedRun,
    applyPayOutcome,
    runDueRetries,
} from "../../src/interimBilling/charger.js";
import { fakeStore } from "./fakeStore.js";
let deps;
const now = new Date("2026-11-20T15:00:00Z");
beforeEach(() => {
    deps = {
        store: fakeStore(),
        config: {
            timezone: "America/Chicago",
            adminEmail: "admin@example.com",
        },
        now: () => now,
        emailClient: jest.fn(),
        sendEmail: jest.fn(),
        stripe: {
            finalizeInvoice: jest
                .fn()
                .mockResolvedValue({
                    hostedInvoiceUrl: "https://invoice.stripe.com/test",
                    invoicePdf: "https://pdf.stripe.com/test",
                }),
            retrieveInvoice: jest
                .fn()
                .mockResolvedValue({ status: "open", paymentIntent: null }),
            payInvoice: jest
                .fn()
                .mockResolvedValue({
                    outcome: "paid",
                    paymentIntentId: "pi_1",
                }),
        },
    };
    deps.store.runs.push({
        id: 1,
        status: "approved",
        approved_invoice_count: 1,
        approved_total_cents: 12000,
    });
    deps.store.invoices.push({
        id: 1,
        run_id: 1,
        carrier_id: 1,
        stripe_invoice_id: "in_1",
        status: "draft",
        total_cents: 12000,
        attempts: 0,
        round: 0,
        tried_backup_this_round: false,
    });
    deps.store.lines.push({ id: 1, invoice_id: 1, status: "invoiced" });
});
it("claims, finalizes, emails the statement, then pays primary and marks lines paid", async () => {
    await chargeApprovedRun(1, deps);
    expect(deps.emailClient).toHaveBeenCalledWith(
        "billing@example.com",
        expect.any(String),
        expect.stringContaining("https://invoice.stripe.com/test")
    );
    expect(deps.stripe.payInvoice).toHaveBeenCalledWith(
        "in_1",
        "pm_primary",
        expect.any(String)
    );
    expect(deps.store.invoices[0].status).toBe("paid");
    expect(deps.store.lines[0].status).toBe("paid");
    expect(deps.store.runs[0].status).toBe("done");
    expect(
        deps.stripe.finalizeInvoice.mock.invocationCallOrder[0]
    ).toBeLessThan(deps.emailClient.mock.invocationCallOrder[0]);
    expect(deps.emailClient.mock.invocationCallOrder[0]).toBeLessThan(
        deps.stripe.payInvoice.mock.invocationCallOrder[0]
    );
});
it("processing never schedules or attempts another payment", async () => {
    deps.stripe.payInvoice.mockResolvedValue({
        outcome: "processing",
        paymentIntentId: "pi_1",
    });
    await chargeApprovedRun(1, deps);
    await chargeApprovedRun(1, deps);
    await runDueRetries(new Date("2026-12-01Z"), deps);
    expect(deps.store.invoices[0]).toMatchObject({
        status: "processing",
        next_attempt_at: null,
    });
    expect(deps.stripe.payInvoice).toHaveBeenCalledTimes(1);
});
it("immediately tries backup then schedules next primary and only runs due retries", async () => {
    deps.stripe.payInvoice.mockResolvedValue({
        outcome: "failed",
        errorCode: "insufficient_funds",
    });
    await chargeApprovedRun(1, deps);
    expect(deps.stripe.payInvoice.mock.calls.map((c) => c[1])).toEqual([
        "pm_primary",
        "pm_backup",
    ]);
    expect(deps.store.invoices[0]).toMatchObject({
        status: "retry_scheduled",
        round: 1,
        next_method: "primary",
        next_attempt_at: new Date("2026-11-23T15:00:00Z"),
    });
    expect(await runDueRetries(now, deps)).toBe(0);
    expect(await runDueRetries(new Date("2026-11-23T15:00:00Z"), deps)).toBe(1);
    expect(deps.stripe.payInvoice).toHaveBeenCalledTimes(4);
});
it("gives up after round 2 and alerts admin and carrier", async () => {
    Object.assign(deps.store.invoices[0], {
        status: "paying",
        round: 2,
        tried_backup_this_round: true,
        first_failure_at: now,
    });
    await applyPayOutcome(
        1,
        { outcome: "failed", errorCode: "card_declined" },
        now,
        deps
    );
    expect(deps.store.invoices[0].status).toBe("failed");
    expect(deps.emailClient).toHaveBeenCalled();
    expect(deps.sendEmail).toHaveBeenCalled();
});
it("resumes a finalizing or paying invoice after a crash and skips processing ones", async () => {
    deps.store.runs[0].status = "charging";
    deps.store.invoices[0].status = "finalizing";
    await chargeApprovedRun(1, deps);
    expect(deps.stripe.payInvoice).toHaveBeenCalledTimes(1);
    deps.store.runs[0].status = "charging";
    Object.assign(deps.store.invoices[0], {
        status: "paying",
        current_pm_id: "pm_primary",
        attempts: 1,
    });
    deps.stripe.retrieveInvoice.mockResolvedValue({
        status: "open",
        paymentIntent: { id: "pi_1", status: "processing" },
    });
    await chargeApprovedRun(1, deps);
    expect(deps.stripe.payInvoice).toHaveBeenCalledTimes(1);
    expect(deps.store.invoices[0].status).toBe("processing");
});
it("never charges a carrier lacking a primary and reports it", async () => {
    deps.store.carriers[0].primary_pm_id = null;
    await chargeApprovedRun(1, deps);
    expect(deps.stripe.payInvoice).not.toHaveBeenCalled();
    expect(deps.sendEmail).toHaveBeenCalled();
});
it("cannot charge without approval or if approved totals differ", async () => {
    deps.store.runs[0].status = "awaiting_approval";
    await chargeApprovedRun(1, deps);
    expect(deps.stripe.payInvoice).not.toHaveBeenCalled();
    deps.store.runs[0].status = "approved";
    deps.store.runs[0].approved_total_cents = 1;
    await expect(chargeApprovedRun(1, deps)).rejects.toThrow(
        "approval_mismatch"
    );
});
