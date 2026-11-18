// In-memory stand-in for src/payments/stripe.js in integration tests. Webhook
// signatures use the real Stripe SDK helpers offline (no network).
import Stripe from "stripe";

const offline = new Stripe("sk_test_offline_never_used");

export function createFakeStripe() {
    let n = 0;
    const id = (prefix) => `${prefix}_${++n}`;
    const customers = new Map();
    const sessions = new Map();
    const intents = new Map();
    const methods = new Map();
    const calls = {
        ensureCustomer: 0,
        createSetupSession: 0,
        expireCheckoutSession: 0,
    };
    const fail = { createSetupSession: null };
    return {
        customers,
        sessions,
        intents,
        methods,
        calls,
        fail,
        async ensureCustomer({ clientId, existingId }) {
            calls.ensureCustomer += 1;
            if (existingId) return { customerId: existingId };
            const found = [...customers.values()].find(
                (c) => c.metadata.client_id === clientId
            );
            if (found) return { customerId: found.id };
            const customer = {
                id: id("cus"),
                metadata: { client_id: clientId },
            };
            customers.set(customer.id, customer);
            return { customerId: customer.id };
        },
        async createSetupSession(input) {
            calls.createSetupSession += 1;
            if (fail.createSetupSession) {
                const code = fail.createSetupSession;
                fail.createSetupSession = null;
                throw Object.assign(new Error(code), { code });
            }
            const intent = {
                id: id("seti"),
                status: "requires_payment_method",
                customer: input.customerId,
                metadata: { payment_setup_id: input.paymentSetupId },
                payment_method: null,
            };
            intents.set(intent.id, intent);
            const session = {
                id: id("cs_test"),
                url: `https://checkout.stripe.test/${n}`,
                expires_at: Math.floor(Date.now() / 1000) + 86400,
                status: "open",
                setup_intent: intent.id,
                metadata: { payment_setup_id: input.paymentSetupId },
                input,
            };
            sessions.set(session.id, session);
            return {
                id: session.id,
                url: session.url,
                expiresAt: session.expires_at,
            };
        },
        async retrieveCheckoutSession(sessionId) {
            return sessions.get(sessionId);
        },
        async expireCheckoutSession(sessionId) {
            calls.expireCheckoutSession += 1;
            sessions.get(sessionId).status = "expired";
        },
        async retrieveSetupIntent(intentId) {
            return intents.get(intentId);
        },
        async retrievePaymentMethod(pmId) {
            return methods.get(pmId);
        },
        constructEvent: (raw, signature, secret) =>
            offline.webhooks.constructEvent(raw, signature, secret),
        // Test controls: what the customer does on the hosted page.
        complete(sessionId, { type = "card", last4 = "4242", customer } = {}) {
            const session = sessions.get(sessionId);
            const intent = intents.get(session.setup_intent);
            const pm = {
                id: id("pm"),
                type,
                customer: customer ?? intent.customer,
                [type]:
                    type === "card"
                        ? { brand: "visa", last4 }
                        : { bank_name: "STRIPE TEST BANK", last4 },
            };
            methods.set(pm.id, pm);
            Object.assign(intent, {
                status: "succeeded",
                payment_method: pm.id,
            });
            session.status = "complete";
            return pm;
        },
        microdeposits(sessionId) {
            const intent = intents.get(sessions.get(sessionId).setup_intent);
            Object.assign(intent, {
                status: "requires_action",
                next_action: { type: "verify_with_microdeposits" },
            });
        },
        failSetup(sessionId) {
            const intent = intents.get(sessions.get(sessionId).setup_intent);
            Object.assign(intent, {
                status: "requires_payment_method",
                last_setup_error: { code: "setup_failed" },
            });
        },
    };
}

export function stripeEvent(secret, { type, object, livemode = false, id }) {
    const payload = JSON.stringify({
        id: id ?? `evt_${Math.random().toString(36).slice(2)}`,
        object: "event",
        type,
        livemode,
        data: { object },
    });
    const header = offline.webhooks.generateTestHeaderString({
        payload,
        secret,
    });
    return { payload, header };
}
