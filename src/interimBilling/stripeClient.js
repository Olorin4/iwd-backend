// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import Stripe from "stripe";
import { randomUUID } from "node:crypto";

export const AUTHORIZATION_TEXT =
    "I authorize Iron Wing Logistics L.L.C. to charge my saved payment method every Friday for dispatch fees on the linehaul rate of loads delivered the previous Monday to Sunday and loads I cancelled after accepting. If both methods are saved, use the backup only if the primary is declined or returned. I authorize electronic bank debits and credits to correct errors. I receive an emailed statement each charge; fees are owed regardless of factoring or broker payment. Declines or returns are retried within 3 business days; new bookings may pause. I may question a statement within 14 days. This authorization continues until I revoke it by email to info@iron-wing-dispatching.com and fees on loads booked before revocation have been charged, after a reasonable opportunity to act.";
export const SUPPORT_EMAIL = "info@iron-wing-dispatching.com";
export class StripeCallError extends Error {
    constructor(code = "stripe_call_failed") {
        super(code);
        this.name = "StripeCallError";
        this.code = code;
    }
}
const safeCode = (code) =>
    typeof code === "string" && /^[a-z_]{1,80}$/.test(code)
        ? code
        : "stripe_call_failed";
const idOf = (value) => (typeof value === "string" ? value : value?.id);

export function assertInvoiceMatches(invoice, expected) {
    const items = invoice.billingItems ?? [];
    if (
        invoice.total !== expected.totalCents ||
        invoice.amount_due !== expected.totalCents ||
        invoice.currency !== "usd" ||
        idOf(invoice.customer) !== expected.customerId ||
        invoice.metadata?.run_id !== String(expected.runId) ||
        invoice.metadata?.carrier_id !== String(expected.carrierId) ||
        (expected.lineFees &&
            (items.length !== expected.lineFees.length ||
                new Set(items.map((i) => i.lineId)).size !== items.length ||
                items.some(
                    (item) =>
                        !expected.lineFees.some(
                            (l) =>
                                l.id === item.lineId &&
                                l.fee_cents === item.amountCents &&
                                item.currency === "usd"
                        )
                )))
    )
        throw new StripeCallError("invoice_mismatch");
}

export function createStripeClient(config, StripeCtor = Stripe) {
    const sdk = new StripeCtor(config.secretKey, {
        apiVersion: config.apiVersion,
    });
    const wrap =
        (fn) =>
        async (...args) => {
            try {
                return await fn(...args);
            } catch (error) {
                throw new StripeCallError(safeCode(error.code));
            }
        };
    const retrieveInvoice = async (id) => {
        const invoice = await sdk.invoices.retrieve(id, {
            expand: ["payments.data.payment.payment_intent"],
        });
        const payment =
            invoice.payments?.data?.find((p) => p.is_default)?.payment ??
            invoice.payments?.data?.[0]?.payment;
        const intent = payment?.payment_intent;
        invoice.paymentIntent =
            typeof intent === "string"
                ? await sdk.paymentIntents.retrieve(intent)
                : (intent ?? null);
        invoice.billingItems = [];
        for await (const line of sdk.invoices.listLineItems(id, { limit: 100 }))
            invoice.billingItems.push({
                lineId: /^\d+$/.test(line.metadata?.line_id)
                    ? Number(line.metadata.line_id)
                    : null,
                amountCents: line.amount,
                currency: line.currency,
            });
        return invoice;
    };
    const outcome = (invoice) => ({
        outcome:
            invoice.status === "paid"
                ? "paid"
                : invoice.paymentIntent?.status === "processing"
                  ? "processing"
                  : "failed",
        paymentIntentId: invoice.paymentIntent?.id ?? null,
        errorCode:
            invoice.status === "paid" ||
            invoice.paymentIntent?.status === "processing"
                ? null
                : safeCode(
                      invoice.paymentIntent?.last_payment_error?.decline_code ??
                          "payment_incomplete"
                  ),
    });
    const api = {
        ensureCustomer: async ({ carrierId, legalName, email }) => {
            for await (const customer of sdk.customers.list({ limit: 100 }))
                if (customer.metadata?.carrier_id === String(carrierId))
                    return { customerId: customer.id };
            const customer = await sdk.customers.create(
                {
                    name: legalName,
                    email,
                    metadata: { carrier_id: String(carrierId) },
                },
                { idempotencyKey: `interim-carrier-${carrierId}` }
            );
            return { customerId: customer.id };
        },
        createSetupSession: async ({
            customerId,
            carrierId,
            role,
            successUrl,
            cancelUrl,
        }) => {
            const metadata = { carrier_id: String(carrierId), role };
            const session = await sdk.checkout.sessions.create(
                {
                    customer: customerId,
                    mode: "setup",
                    currency: "usd",
                    allowed_payment_method_types: ["card", "us_bank_account"],
                    locale: "en",
                    custom_text: { submit: { message: AUTHORIZATION_TEXT } },
                    payment_method_options: {
                        us_bank_account: {
                            financial_connections: {
                                permissions: ["payment_method"],
                            },
                        },
                    },
                    metadata,
                    setup_intent_data: { metadata },
                    success_url: successUrl,
                    cancel_url: cancelUrl,
                },
                {
                    idempotencyKey: `interim-setup-${carrierId}-${role}-${randomUUID()}`,
                }
            );
            return { id: session.id, url: session.url };
        },
        retrieveSetupIntent: (id) => sdk.setupIntents.retrieve(id),
        retrievePaymentMethod: (id) => sdk.paymentMethods.retrieve(id),
        retrieveCharge: (id) => sdk.charges.retrieve(id),
        retrieveDispute: (id) => sdk.disputes.retrieve(id),
        retrieveInvoice,
        createDraftInvoice: async ({ customerId, runId, carrierId }) => {
            const invoice = await sdk.invoices.create(
                {
                    customer: customerId,
                    collection_method: "charge_automatically",
                    auto_advance: false,
                    pending_invoice_items_behavior: "exclude",
                    statement_descriptor: "IRON WING DISPATCH",
                    payment_settings: {
                        payment_method_types: ["card", "us_bank_account"],
                    },
                    footer: `Questions within 14 days: ${SUPPORT_EMAIL}, +1 (817) 865-3016.`,
                    metadata: {
                        run_id: String(runId),
                        carrier_id: String(carrierId),
                    },
                },
                { idempotencyKey: `interim-invoice-${runId}-${carrierId}` }
            );
            return { invoiceId: invoice.id };
        },
        addInvoiceItem: async ({
            customerId,
            invoiceId,
            lineId,
            amountCents,
            description,
        }) => {
            const item = await sdk.invoiceItems.create(
                {
                    customer: customerId,
                    invoice: invoiceId,
                    currency: "usd",
                    price_data: {
                        currency: "usd",
                        product: config.productId,
                        unit_amount: amountCents,
                    },
                    description,
                    metadata: { line_id: String(lineId) },
                },
                { idempotencyKey: `interim-line-${lineId}` }
            );
            return { itemId: item.id };
        },
        listInvoicesForRun: async (customerId, runId) => {
            const result = [];
            for await (const invoice of sdk.invoices.list({
                customer: customerId,
                limit: 100,
            })) {
                if (invoice.metadata?.run_id !== String(runId)) continue;
                const itemLineIds = [];
                for await (const line of sdk.invoices.listLineItems(
                    invoice.id,
                    { limit: 100 }
                ))
                    itemLineIds.push(
                        /^\d+$/.test(line.metadata?.line_id)
                            ? Number(line.metadata.line_id)
                            : null
                    );
                result.push({
                    id: invoice.id,
                    status: invoice.status,
                    itemLineIds,
                });
            }
            return result;
        },
        finalizeInvoice: async (id) => {
            const existing = await retrieveInvoice(id);
            const invoice =
                existing.status === "draft"
                    ? await sdk.invoices.finalizeInvoice(
                          id,
                          { auto_advance: false },
                          { idempotencyKey: `interim-finalize-${id}` }
                      )
                    : existing;
            return {
                hostedInvoiceUrl: invoice.hosted_invoice_url,
                invoicePdf: invoice.invoice_pdf,
            };
        },
        payInvoice: async (id, pmId, attemptKey = "initial", expected) => {
            const before = await retrieveInvoice(id);
            if (expected) assertInvoiceMatches(before, expected);
            if (
                before.status === "paid" ||
                before.paymentIntent?.status === "processing"
            )
                return outcome(before);
            try {
                await sdk.invoices.pay(
                    id,
                    { payment_method: pmId, off_session: true },
                    { idempotencyKey: `interim-pay-${id}-${attemptKey}` }
                );
            } catch (error) {
                if (error.type === "StripeCardError")
                    return {
                        outcome: "failed",
                        paymentIntentId:
                            idOf(error.payment_intent) ??
                            before.paymentIntent?.id ??
                            null,
                        errorCode: safeCode(error.decline_code ?? error.code),
                    };
                throw error;
            }
            return outcome(await retrieveInvoice(id));
        },
        constructEvent: (...args) => sdk.webhooks.constructEvent(...args),
    };
    return Object.fromEntries(
        Object.entries(api).map(([key, fn]) => [key, wrap(fn)])
    );
}
