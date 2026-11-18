// Permanent Stripe client for client onboarding (design §8). Own client and
// pinned API version; never imports interim billing. Card and ACH payment
// methods are collected only on Stripe's hosted Checkout page (mode: setup).
import Stripe from "stripe";

export const PAYMENTS_STRIPE_API_VERSION = "2026-10-28.endive";

export class PaymentsStripeError extends Error {
    constructor(code = "stripe_call_failed") {
        super(code);
        this.name = "PaymentsStripeError";
        this.code = code;
    }
}

const safeCode = (code) =>
    typeof code === "string" && /^[a-z_]{1,80}$/.test(code)
        ? code
        : "stripe_call_failed";
export const idOf = (value) =>
    typeof value === "string" ? value : (value?.id ?? null);
const UUID = /^[0-9a-f-]{36}$/;

export function assertKeyAllowed({ secretKey, live }) {
    if (/^(sk|rk)_test_/.test(secretKey ?? "")) return;
    if (live && /^(sk|rk)_live_/.test(secretKey ?? "")) return;
    throw new PaymentsStripeError("stripe_live_key_refused");
}

export function createPaymentsStripe(config, StripeCtor = Stripe) {
    assertKeyAllowed(config);
    const sdk = new StripeCtor(config.secretKey, {
        apiVersion: config.apiVersion ?? PAYMENTS_STRIPE_API_VERSION,
        maxNetworkRetries: 2,
        timeout: 20000,
    });
    const api = {
        /** Finds the customer by metadata.client_id, else creates it once. */
        async ensureCustomer({ clientId, name, email, existingId }) {
            if (!UUID.test(clientId))
                throw new PaymentsStripeError("invalid_client_id");
            if (existingId) {
                const customer = await sdk.customers.retrieve(existingId);
                if (
                    customer.deleted ||
                    customer.metadata?.client_id !== clientId
                )
                    throw new PaymentsStripeError(
                        "customer_ownership_mismatch"
                    );
                return { customerId: customer.id };
            }
            const found = await sdk.customers.search({
                query: `metadata['client_id']:'${clientId}'`,
                limit: 1,
            });
            if (found.data?.[0]) return { customerId: found.data[0].id };
            const customer = await sdk.customers.create(
                { name, email, metadata: { client_id: clientId } },
                { idempotencyKey: `onboarding-client-${clientId}` }
            );
            return { customerId: customer.id };
        },
        async createSetupSession({
            customerId,
            clientId,
            requestId,
            paymentSetupId,
            methods,
            successUrl,
            cancelUrl,
        }) {
            const metadata = {
                client_id: clientId,
                onboarding_request_id: requestId,
                payment_setup_id: paymentSetupId,
            };
            const session = await sdk.checkout.sessions.create(
                {
                    customer: customerId,
                    mode: "setup",
                    currency: "usd",
                    // The pinned API version takes allowed_payment_method_types.
                    allowed_payment_method_types: methods,
                    locale: "en",
                    ...(methods.includes("us_bank_account")
                        ? {
                              payment_method_options: {
                                  us_bank_account: {
                                      financial_connections: {
                                          permissions: ["payment_method"],
                                      },
                                  },
                              },
                          }
                        : {}),
                    metadata,
                    setup_intent_data: { metadata },
                    success_url: successUrl,
                    cancel_url: cancelUrl,
                },
                { idempotencyKey: `onboarding-setup-${paymentSetupId}` }
            );
            return {
                id: session.id,
                url: session.url,
                expiresAt: session.expires_at,
            };
        },
        retrieveCheckoutSession: (id) => sdk.checkout.sessions.retrieve(id),
        expireCheckoutSession: (id) => sdk.checkout.sessions.expire(id),
        retrieveSetupIntent: (id) => sdk.setupIntents.retrieve(id),
        retrievePaymentMethod: (id) => sdk.paymentMethods.retrieve(id),
        constructEvent: (raw, signature, secret) =>
            sdk.webhooks.constructEvent(raw, signature, secret),
    };
    return Object.fromEntries(
        Object.entries(api).map(([key, fn]) => [
            key,
            async (...args) => {
                try {
                    return await fn(...args);
                } catch (error) {
                    if (error instanceof PaymentsStripeError) throw error;
                    if (key === "constructEvent")
                        throw new PaymentsStripeError("invalid_signature");
                    throw new PaymentsStripeError(safeCode(error?.code));
                }
            },
        ])
    );
}
