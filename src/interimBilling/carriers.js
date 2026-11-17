// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
export class BillingInputError extends Error {
    constructor(code, status = 400) {
        super(code);
        this.code = code;
        this.status = status;
    }
}
const validText = (value, max) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= max &&
    ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const validIds = (ids) =>
    Array.isArray(ids) &&
    ids.length <= 50 &&
    ids.every((id) => Number.isSafeInteger(id) && id > 0 && id <= 2147483647) &&
    new Set(ids).size === ids.length;
export async function createCarrier(input, deps) {
    const {
        legalName,
        mc = null,
        usdot = null,
        email,
        feeBp,
        driverIds = [],
        truckIds = [],
    } = input;
    if (
        !validText(legalName, 200) ||
        !validText(email, 254) ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !Number.isInteger(feeBp) ||
        feeBp < 1 ||
        feeBp > 3000 ||
        !validIds(driverIds) ||
        !validIds(truckIds) ||
        [mc, usdot].some((v) => v !== null && !/^\d{1,20}$/.test(v))
    )
        throw new BillingInputError("invalid_carrier");
    for (const [kind, ids] of [
        ["DRIVER", driverIds],
        ["TRUCK", truckIds],
    ])
        for (const id of ids)
            if (await deps.store.findCarrierByAsset(kind, id))
                throw new BillingInputError("asset_conflict", 409);
    try {
        const row = await deps.store.createCarrier({
            legal_name: legalName.trim(),
            mc,
            usdot,
            email,
            fee_bp: feeBp,
            driverIds,
            truckIds,
        });
        return { id: row.id };
    } catch (error) {
        if (error.code === "P2002")
            throw new BillingInputError("asset_conflict", 409);
        throw error;
    }
}
export async function sendSetupLink(carrierId, role, deps) {
    if (!["primary", "backup"].includes(role))
        throw new BillingInputError("invalid_role");
    const carrier = await deps.store.getCarrier(carrierId);
    if (!carrier) throw new BillingInputError("carrier_not_found", 404);
    let customerId = carrier.stripe_customer_id;
    if (!customerId) {
        ({ customerId } = await deps.stripe.ensureCustomer({
            carrierId,
            legalName: carrier.legal_name,
            email: carrier.email,
        }));
        await deps.store.setStripeCustomerId(carrierId, customerId);
    }
    const { url } = await deps.stripe.createSetupSession({
        customerId,
        carrierId,
        role,
        successUrl: "https://iron-wing-dispatching.com/?billing=setup-complete",
        cancelUrl: "https://iron-wing-dispatching.com/?billing=setup-cancelled",
    });
    await deps.emailClient(
        carrier.email,
        "Set up dispatch fee payments",
        `Save your ${role} payment method securely with Stripe: ${url}\nNothing is charged during setup.`
    );
    return { url };
}
