// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import Stripe from "stripe";
import {
    createWebhookHandler,
    handleEvent,
    interimBillingRawBody,
} from "../../src/interimBilling/webhook.js";
import { fakeStore } from "./fakeStore.js";
const stripe = new Stripe("sk_test_fake");
let deps, events;
const event = (type, id = "evt_1") => ({
    id,
    type,
    livemode: false,
    data: { object: { id: "object_1", metadata: { carrier_id: "999" } } },
});
beforeEach(() => {
    events = new Set();
    const store = fakeStore();
    store.getInvoiceByStripeId = jest.fn(async () => store.invoices[0]);
    store.setPaymentMethod = jest.fn();
    store.recordStripeEvent = jest.fn(async (id) => {
        if (events.has(id)) return false;
        events.add(id);
        return true;
    });
    store.withTransaction = async (fn) => {
        const snapshot = new Set(events);
        try {
            return await fn();
        } catch (e) {
            events = snapshot;
            throw e;
        }
    };
    store.invoices.push({
        id: 1,
        carrier_id: 1,
        status: "processing",
        round: 0,
        tried_backup_this_round: false,
        stripe_invoice_id: "in_1",
        run_id: 1,
    });
    store.runs.push({ id: 1, status: "done", approved_at: new Date() });
    store.lines.push({ id: 1, invoice_id: 1, status: "invoiced" });
    deps = {
        store,
        config: {
            mode: "sandbox",
            stripe: { webhookSecret: "whsec_fake" },
            adminEmail: "admin@example.com",
            timezone: "America/Chicago",
        },
        sendEmail: jest.fn(),
        emailClient: jest.fn(),
        stripe: {
            constructEvent: async (...args) =>
                stripe.webhooks.constructEvent(...args),
            retrieveSetupIntent: jest.fn().mockResolvedValue({
                status: "succeeded",
                customer: "cus_1",
                payment_method: "pm_1",
                metadata: { carrier_id: "1", role: "backup" },
            }),
            retrievePaymentMethod: jest.fn().mockResolvedValue({
                id: "pm_1",
                customer: "cus_1",
                type: "card",
                card: { brand: "visa", last4: "4242" },
            }),
            retrieveInvoice: jest.fn().mockResolvedValue({
                id: "in_1",
                customer: "cus_1",
                status: "paid",
                paymentIntent: { id: "pi_1", status: "succeeded" },
            }),
            retrieveDispute: jest
                .fn()
                .mockResolvedValue({ id: "dp_1", charge: "ch_1" }),
            retrieveCharge: jest.fn().mockResolvedValue({ customer: "cus_1" }),
        },
    };
});
it("captures exact raw bytes only for webhook paths", () => {
    const buf = Buffer.from("{}"),
        req = { originalUrl: "/interim-billing/webhook?x=1" };
    interimBillingRawBody(req, {}, buf);
    expect(req.rawBody).toBe(buf);
    const other = { originalUrl: "/other" };
    interimBillingRawBody(other, {}, buf);
    expect(other.rawBody).toBeUndefined();
});
it("accepts real signatures, rejects missing or wrong ones without effects", async () => {
    const payload = JSON.stringify(event("unknown"));
    const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: "whsec_fake",
    });
    for (const [sig, code] of [
        [signature, 200],
        [undefined, 400],
        ["bad", 400],
    ]) {
        const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
        await createWebhookHandler(deps)(
            {
                rawBody: Buffer.from(payload),
                headers: { "stripe-signature": sig },
            },
            res
        );
        expect(res.status).toHaveBeenCalledWith(code);
    }
    expect(deps.store.recordStripeEvent).toHaveBeenCalledTimes(1);
});
it("deduplicates effects and rolls back event recording on failure", async () => {
    await handleEvent(event("setup_intent.succeeded"), deps);
    await handleEvent(event("setup_intent.succeeded"), deps);
    expect(deps.store.setPaymentMethod).toHaveBeenCalledTimes(1);
    deps.store.setPaymentMethod.mockRejectedValue(new Error("effect_failed"));
    await expect(
        handleEvent(event("setup_intent.succeeded", "evt_2"), deps)
    ).rejects.toThrow();
    expect(events.has("evt_2")).toBe(false);
});
it("refetches setup and method, verifies ownership and saves safe details", async () => {
    await handleEvent(event("setup_intent.succeeded"), deps);
    expect(deps.stripe.retrieveSetupIntent).toHaveBeenCalledWith("object_1");
    expect(deps.stripe.retrievePaymentMethod).toHaveBeenCalledWith("pm_1");
    expect(deps.store.setPaymentMethod).toHaveBeenCalledWith(1, "backup", {
        pmId: "pm_1",
        brand: "visa",
        last4: "4242",
    });
});
it("ignores unsupported, unverified or foreign methods", async () => {
    for (const patch of [{ type: "sepa_debit" }, { customer: "cus_foreign" }]) {
        deps.stripe.retrievePaymentMethod.mockResolvedValue({
            id: "pm_1",
            type: "card",
            customer: "cus_1",
            card: { brand: "visa", last4: "4242" },
            ...patch,
        });
        await handleEvent(
            event("setup_intent.succeeded", `evt_${JSON.stringify(patch)}`),
            deps
        );
    }
    deps.stripe.retrieveSetupIntent.mockResolvedValue({
        status: "requires_action",
    });
    await handleEvent(event("setup_intent.succeeded", "evt_pending"), deps);
    expect(deps.store.setPaymentMethod).not.toHaveBeenCalled();
});
it("marks paid invoice and lines, ignores stale failures and finalized events", async () => {
    await handleEvent(event("invoice.paid"), deps);
    expect(deps.store.invoices[0].status).toBe("paid");
    expect(deps.store.invoices[0].last_error_code).toBeNull();
    expect(deps.store.lines[0].status).toBe("paid");
    await handleEvent(event("invoice.payment_failed", "evt_later"), deps);
    await handleEvent(event("invoice.finalized", "evt_final"), deps);
    expect(deps.store.invoices[0].status).toBe("paid");
});
it("does nothing on failure while ACH processing, schedules a real failure only once", async () => {
    deps.stripe.retrieveInvoice.mockResolvedValue({
        id: "in_1",
        customer: "cus_1",
        status: "open",
        paymentIntent: { id: "pi_1", status: "processing" },
    });
    await handleEvent(event("invoice.payment_failed"), deps);
    expect(deps.store.invoices[0].status).toBe("processing");
    deps.stripe.retrieveInvoice.mockResolvedValue({
        id: "in_1",
        customer: "cus_1",
        status: "open",
        paymentIntent: { id: "pi_1", status: "requires_payment_method" },
    });
    await handleEvent(event("invoice.payment_failed", "evt_failed"), deps);
    expect(deps.store.invoices[0]).toMatchObject({
        status: "retry_scheduled",
        next_method: "backup",
    });
});
it("refetches disputes and alerts only for a known customer", async () => {
    await handleEvent(event("charge.dispute.created"), deps);
    expect(deps.sendEmail).toHaveBeenCalled();
    expect(deps.store.invoices[0].status).toBe("processing");
});

it("alerts on a verified late return without retrying or confusing an old decline", async () => {
    Object.assign(deps.store.invoices[0], {
        status: "paid",
        payment_intent_id: "pi_1",
    });
    deps.stripe.retrieveInvoice.mockResolvedValue({
        id: "in_1",
        customer: "cus_1",
        status: "paid",
        paymentIntent: {
            id: "pi_1",
            status: "requires_payment_method",
            last_payment_error: { code: "bank_account_closed" },
        },
    });
    await handleEvent(event("invoice.payment_failed"), deps);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
    expect(deps.store.invoices[0].status).toBe("paid");
    deps.stripe.retrieveInvoice.mockResolvedValue({
        id: "in_1",
        customer: "cus_1",
        status: "paid",
        paymentIntent: { id: "pi_1", status: "succeeded" },
    });
    await handleEvent(event("invoice.payment_failed", "evt_old_decline"), deps);
    expect(deps.sendEmail).toHaveBeenCalledTimes(1);
});
