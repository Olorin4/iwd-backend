import { createPaymentsStripe } from "../../src/payments/stripe";

function fakeCtor() {
    const calls = [];
    const record =
        (name, result) =>
        async (...args) => {
            calls.push([name, ...args]);
            return typeof result === "function" ? result(...args) : result;
        };
    const sdk = {
        customers: {
            retrieve: record("customers.retrieve", {
                id: "cus_1",
                metadata: { client_id: "11111111-1111-4111-8111-111111111111" },
            }),
            search: record("customers.search", { data: [] }),
            create: record("customers.create", { id: "cus_new" }),
        },
        checkout: {
            sessions: {
                create: record("sessions.create", {
                    id: "cs_1",
                    url: "https://checkout",
                    expires_at: 10,
                }),
                retrieve: record("sessions.retrieve", {}),
                expire: record("sessions.expire", {}),
            },
        },
        setupIntents: { retrieve: record("si.retrieve", {}) },
        paymentMethods: { retrieve: record("pm.retrieve", {}) },
        webhooks: {
            constructEvent: () => {
                throw new Error("bad signature");
            },
        },
    };
    function Ctor(key, options) {
        calls.push(["ctor", key, options]);
        return sdk;
    }
    return { Ctor, calls };
}

const clientId = "11111111-1111-4111-8111-111111111111";

it("refuses live keys unless explicitly confirmed and pins the API version", () => {
    const { Ctor, calls } = fakeCtor();
    expect(() =>
        createPaymentsStripe({ secretKey: "sk_live_x", live: false }, Ctor)
    ).toThrow("stripe_live_key_refused");
    expect(() =>
        createPaymentsStripe({ secretKey: "pk_test_x" }, Ctor)
    ).toThrow("stripe_live_key_refused");
    createPaymentsStripe({ secretKey: "rk_test_x" }, Ctor);
    expect(calls[0][2].apiVersion).toBe("2026-10-28.endive");
});

it("finds or creates the customer by metadata.client_id with an idempotency key", async () => {
    const { Ctor, calls } = fakeCtor();
    const stripe = createPaymentsStripe({ secretKey: "sk_test_x" }, Ctor);
    expect(
        await stripe.ensureCustomer({
            clientId,
            name: "Example",
            email: "e@example.test",
        })
    ).toEqual({
        customerId: "cus_new",
    });
    const search = calls.find((c) => c[0] === "customers.search");
    expect(search[1].query).toBe(`metadata['client_id']:'${clientId}'`);
    const create = calls.find((c) => c[0] === "customers.create");
    expect(create[1].metadata).toEqual({ client_id: clientId });
    expect(create[2]).toEqual({
        idempotencyKey: `onboarding-client-${clientId}`,
    });
    expect(
        await stripe.ensureCustomer({ clientId, existingId: "cus_1" })
    ).toEqual({ customerId: "cus_1" });
    await expect(
        stripe.ensureCustomer({ clientId: "x' OR '1" })
    ).rejects.toMatchObject({ code: "invalid_client_id" });
});

it("creates a setup-mode Checkout session for exactly the agreed methods", async () => {
    const { Ctor, calls } = fakeCtor();
    const stripe = createPaymentsStripe({ secretKey: "sk_test_x" }, Ctor);
    await stripe.createSetupSession({
        customerId: "cus_1",
        clientId,
        requestId: "r1",
        paymentSetupId: "p1",
        methods: ["card", "us_bank_account"],
        successUrl: "https://ok",
        cancelUrl: "https://cancel",
    });
    const [, params, options] = calls.find((c) => c[0] === "sessions.create");
    expect(params).toMatchObject({
        mode: "setup",
        customer: "cus_1",
        allowed_payment_method_types: ["card", "us_bank_account"],
        payment_method_options: {
            us_bank_account: {
                financial_connections: { permissions: ["payment_method"] },
            },
        },
        success_url: "https://ok",
        cancel_url: "https://cancel",
        setup_intent_data: {
            metadata: {
                payment_setup_id: "p1",
                client_id: clientId,
                onboarding_request_id: "r1",
            },
        },
    });
    expect(options).toEqual({ idempotencyKey: "onboarding-setup-p1" });
    await stripe.createSetupSession({
        customerId: "c",
        clientId,
        requestId: "r",
        paymentSetupId: "p2",
        methods: ["card"],
    });
    const second = calls.filter((c) => c[0] === "sessions.create")[1][1];
    expect(second.allowed_payment_method_types).toEqual(["card"]);
    expect(second.payment_method_options).toBeUndefined();
    await expect(
        stripe.constructEvent("raw", "sig", "whsec")
    ).rejects.toMatchObject({ code: "invalid_signature" });
});
