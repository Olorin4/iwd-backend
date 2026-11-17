// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    createStripeClient,
    AUTHORIZATION_TEXT,
    StripeCallError,
} from "../../src/interimBilling/stripeClient.js";
let sdk, ctor, api;
const list = (rows) => ({
    async *[Symbol.asyncIterator]() {
        yield* rows;
    },
});
beforeEach(() => {
    sdk = {
        customers: {
            create: jest.fn().mockResolvedValue({ id: "cus_1" }),
            list: jest.fn(() => list([])),
        },
        checkout: {
            sessions: {
                create: jest.fn().mockResolvedValue({
                    id: "cs_1",
                    url: "https://checkout.stripe.com/test",
                }),
            },
        },
        setupIntents: { retrieve: jest.fn() },
        paymentMethods: { retrieve: jest.fn() },
        paymentIntents: { retrieve: jest.fn() },
        invoices: {
            create: jest.fn().mockResolvedValue({ id: "in_1" }),
            list: jest.fn(() => list([])),
            listLineItems: jest.fn(() => list([])),
            finalizeInvoice: jest.fn().mockResolvedValue({
                hosted_invoice_url: "hosted",
                invoice_pdf: "pdf",
            }),
            pay: jest.fn(),
            retrieve: jest.fn(),
        },
        invoiceItems: { create: jest.fn().mockResolvedValue({ id: "ii_1" }) },
        webhooks: { constructEvent: jest.fn() },
    };
    ctor = jest.fn(() => sdk);
    api = createStripeClient(
        {
            secretKey: "sk_test_fake",
            apiVersion: "2026-10-28.endive",
            productId: "prod_test",
        },
        ctor
    );
});
it("pins the API and creates metadata-tagged customers", async () => {
    expect(ctor).toHaveBeenCalledWith("sk_test_fake", {
        apiVersion: "2026-10-28.endive",
    });
    expect(
        await api.ensureCustomer({
            carrierId: 2,
            legalName: "Test",
            email: "test@example.com",
        })
    ).toEqual({ customerId: "cus_1" });
});
it("creates hosted setup with both methods and authorization", async () => {
    await api.createSetupSession({
        customerId: "cus_1",
        carrierId: 2,
        role: "backup",
        successUrl: "success",
        cancelUrl: "cancel",
    });
    const [data, opts] = sdk.checkout.sessions.create.mock.calls[0];
    expect(data).toMatchObject({
        mode: "setup",
        payment_method_types: ["card", "us_bank_account"],
        locale: "en",
        custom_text: { submit: { message: AUTHORIZATION_TEXT } },
        setup_intent_data: { metadata: { carrier_id: "2", role: "backup" } },
        payment_method_options: {
            us_bank_account: {
                financial_connections: { permissions: ["payment_method"] },
            },
        },
    });
    expect(AUTHORIZATION_TEXT.length).toBeLessThan(1000);
    expect(opts.idempotencyKey).toBeTruthy();
});
it("creates controlled drafts and attached items", async () => {
    await api.createDraftInvoice({
        customerId: "cus_1",
        runId: 3,
        carrierId: 2,
    });
    expect(sdk.invoices.create.mock.calls[0][0]).toMatchObject({
        auto_advance: false,
        collection_method: "charge_automatically",
        statement_descriptor: "IRON WING DISPATCH",
        metadata: { run_id: "3", carrier_id: "2" },
        payment_settings: { payment_method_types: ["card", "us_bank_account"] },
        footer: expect.stringContaining("817"),
    });
    await api.addInvoiceItem({
        customerId: "cus_1",
        invoiceId: "in_1",
        lineId: 4,
        amountCents: 12000,
        description: "Load 1",
    });
    expect(sdk.invoiceItems.create).toHaveBeenCalledWith(
        expect.objectContaining({
            invoice: "in_1",
            currency: "usd",
            price_data: {
                currency: "usd",
                product: "prod_test",
                unit_amount: 12000,
            },
            metadata: { line_id: "4" },
        }),
        { idempotencyKey: expect.stringContaining("4") }
    );
});
it("lists all customer invoices by metadata and all items", async () => {
    sdk.invoices.list.mockReturnValue(
        list([
            { id: "in_1", status: "draft", metadata: { run_id: "3" } },
            { id: "in_other", metadata: { run_id: "9" } },
        ])
    );
    sdk.invoices.listLineItems.mockReturnValue(
        list([{ metadata: { line_id: "4" } }])
    );
    expect(await api.listInvoicesForRun("cus_1", 3)).toEqual([
        { id: "in_1", status: "draft", itemLineIds: [4] },
    ]);
    expect(sdk.invoices.list).toHaveBeenCalledWith({
        customer: "cus_1",
        limit: 100,
    });
});
it("never retries processing payments and recognizes paid invoices", async () => {
    sdk.invoices.retrieve.mockResolvedValue({
        status: "open",
        payments: {
            data: [
                {
                    payment: {
                        type: "payment_intent",
                        payment_intent: { id: "pi_1", status: "processing" },
                    },
                },
            ],
        },
    });
    expect(await api.payInvoice("in_1", "pm_1")).toMatchObject({
        outcome: "processing",
        paymentIntentId: "pi_1",
    });
    expect(sdk.invoices.pay).not.toHaveBeenCalled();
    sdk.invoices.retrieve.mockResolvedValue({ status: "paid" });
    expect(await api.payInvoice("in_1", "pm_1")).toMatchObject({
        outcome: "paid",
    });
});
it("maps declines and hides raw exceptions", async () => {
    sdk.invoices.retrieve.mockResolvedValue({ status: "open" });
    sdk.invoices.pay.mockRejectedValue({
        type: "StripeCardError",
        decline_code: "insufficient_funds",
        message: "private",
    });
    expect(await api.payInvoice("in_1", "pm_1")).toMatchObject({
        outcome: "failed",
        errorCode: "insufficient_funds",
    });
    sdk.invoiceItems.create.mockRejectedValue(new Error("private"));
    await expect(api.addInvoiceItem({})).rejects.toBeInstanceOf(
        StripeCallError
    );
    await expect(api.addInvoiceItem({})).rejects.not.toThrow("private");
});

it("rejects a changed total or untagged invoice item before paying", async () => {
    sdk.invoices.retrieve.mockResolvedValue({
        id: "in_1",
        status: "open",
        total: 12000,
        amount_due: 12000,
        currency: "usd",
        customer: "cus_1",
        metadata: { run_id: "3", carrier_id: "2" },
    });
    sdk.invoices.listLineItems.mockReturnValue(
        list([{ amount: 12000, currency: "usd", metadata: { line_id: "4" } }])
    );
    await expect(
        api.payInvoice("in_1", "pm_1", "attempt-1", {
            totalCents: 24000,
            customerId: "cus_1",
            runId: 3,
            carrierId: 2,
            lineFees: [{ id: 4, fee_cents: 24000 }],
        })
    ).rejects.toThrow("invoice_mismatch");
    expect(sdk.invoices.pay).not.toHaveBeenCalled();
});
