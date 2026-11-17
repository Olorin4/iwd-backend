// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { applyPayOutcomeLocked } from "./charger.js";
import { SUPPORT_EMAIL } from "./stripeClient.js";
const idOf = (value) => (typeof value === "string" ? value : value?.id);
export function interimBillingRawBody(req, res, buf) {
    if (req.originalUrl?.startsWith("/interim-billing/webhook"))
        req.rawBody = buf;
}
export async function handleEvent(event, deps) {
    if (event.livemode !== (deps.config.mode === "live"))
        throw new Error("stripe_mode_mismatch");
    return deps.store.withBillingLock(() =>
        deps.store.withTransaction(async () => {
            if (!(await deps.store.recordStripeEvent(event.id, event.type)))
                return;
            const { stripe, store } = deps,
                objectId = event.data?.object?.id;
            if (event.type === "setup_intent.succeeded") {
                const setup = await stripe.retrieveSetupIntent(objectId);
                if (
                    setup.status !== "succeeded" ||
                    !/^\d+$/.test(setup.metadata?.carrier_id) ||
                    !["primary", "backup"].includes(setup.metadata?.role)
                )
                    return;
                const carrier = await store.getCarrier(
                    Number(setup.metadata.carrier_id)
                );
                if (
                    !carrier ||
                    carrier.stripe_customer_id !== idOf(setup.customer)
                )
                    return;
                const method = await stripe.retrievePaymentMethod(
                    idOf(setup.payment_method)
                );
                if (
                    idOf(method.customer) !== carrier.stripe_customer_id ||
                    !["card", "us_bank_account"].includes(method.type)
                )
                    return;
                const detail = method[method.type];
                if (
                    !/^pm_[A-Za-z0-9]+$/.test(method.id) ||
                    !/^\d{4}$/.test(detail?.last4)
                )
                    return;
                await store.setPaymentMethod(carrier.id, setup.metadata.role, {
                    pmId: method.id,
                    brand:
                        method.type === "card"
                            ? detail.brand
                            : "us_bank_account",
                    last4: detail.last4,
                });
            } else if (
                [
                    "invoice.paid",
                    "invoice.payment_failed",
                    "invoice.finalized",
                ].includes(event.type)
            ) {
                const remote = await stripe.retrieveInvoice(objectId);
                const invoice = await store.getInvoiceByStripeId(remote.id);
                if (!invoice) return;
                const carrier = await store.getCarrier(invoice.carrier_id);
                if (idOf(remote.customer) !== carrier?.stripe_customer_id)
                    return;
                const run = await store.getRun(invoice.run_id);
                if (!run?.approved_at) return;
                if (event.type === "invoice.finalized") return;
                // A current verified failure after payment is an alert, never a retry.
                const lateFailure =
                    event.type === "invoice.payment_failed" &&
                    invoice.status === "paid" &&
                    invoice.payment_intent_id === remote.paymentIntent?.id &&
                    ["requires_payment_method", "canceled"].includes(
                        remote.paymentIntent?.status
                    ) &&
                    !!remote.paymentIntent?.last_payment_error;
                const outcome = lateFailure
                    ? "failed"
                    : remote.status === "paid"
                      ? "paid"
                      : remote.paymentIntent?.status === "processing"
                        ? "processing"
                        : event.type === "invoice.payment_failed"
                          ? "failed"
                          : null;
                if (!outcome) return;
                if (
                    outcome === "failed" &&
                    invoice.payment_intent_id &&
                    remote.paymentIntent?.id !== invoice.payment_intent_id
                )
                    return;
                await applyPayOutcomeLocked(
                    invoice.id,
                    {
                        outcome,
                        paymentIntentId: remote.paymentIntent?.id,
                        errorCode:
                            remote.paymentIntent?.last_payment_error
                                ?.decline_code ?? "payment_failed",
                    },
                    new Date(),
                    { ...deps, deferImmediateRetry: true }
                );
            } else if (event.type === "charge.dispute.created") {
                const dispute = await stripe.retrieveDispute(objectId),
                    charge = await stripe.retrieveCharge(idOf(dispute.charge));
                const carriers = await store.listCarriers();
                if (
                    !carriers.some(
                        (c) => c.stripe_customer_id === idOf(charge.customer)
                    )
                )
                    return;
                await deps.sendEmail({
                    from: SUPPORT_EMAIL,
                    to: deps.config.adminEmail,
                    subject: "Dispatch payment dispute",
                    text: `Dispute ${dispute.id}; review in Stripe. No automatic retry.`,
                });
            }
        })
    );
}
export function createWebhookHandler(deps) {
    return async (req, res) => {
        let event;
        if (!deps.config.enabled && deps.config.enabled !== undefined)
            return res.status(404).json({ error: "not_found" });
        try {
            if (!req.rawBody || !req.headers["stripe-signature"])
                throw new Error("signature_missing");
            event = await deps.stripe.constructEvent(
                req.rawBody,
                req.headers["stripe-signature"],
                deps.config.stripe.webhookSecret
            );
        } catch {
            return res.status(400).json({ error: "invalid_signature" });
        }
        try {
            await handleEvent(event, deps);
            return res.status(200).json({ received: true });
        } catch {
            return res.status(503).json({ error: "webhook_retry" });
        }
    };
}
