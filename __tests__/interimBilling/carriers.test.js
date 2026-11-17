// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    createCarrier,
    sendSetupLink,
} from "../../src/interimBilling/carriers.js";
const input = {
    legalName: "Test carrier",
    mc: "123",
    usdot: "456",
    email: "billing@example.com",
    feeBp: 500,
    driverIds: [1],
    truckIds: [2],
};
let deps, carrier;
beforeEach(() => {
    carrier = {
        id: 3,
        legal_name: input.legalName,
        email: input.email,
        stripe_customer_id: null,
    };
    deps = {
        store: {
            createCarrier: jest.fn().mockResolvedValue(carrier),
            findCarrierByAsset: jest.fn().mockResolvedValue(null),
            getCarrier: jest.fn().mockResolvedValue(carrier),
            setStripeCustomerId: jest.fn(async (id, cid) => {
                carrier.stripe_customer_id = cid;
            }),
        },
        stripe: {
            ensureCustomer: jest
                .fn()
                .mockResolvedValue({ customerId: "cus_1" }),
            createSetupSession: jest
                .fn()
                .mockResolvedValue({ url: "https://checkout.stripe.com/test" }),
        },
        emailClient: jest.fn(),
    };
});
it.each([0, 3001, 5.5])("rejects invalid fee %s", async (feeBp) =>
    expect(createCarrier({ ...input, feeBp }, deps)).rejects.toThrow(
        "invalid_carrier"
    )
);
it("validates email, asset bounds and name", async () => {
    for (const patch of [
        { email: "bad" },
        { driverIds: Array(51).fill(1) },
        { truckIds: [-1] },
        { legalName: "" },
    ])
        await expect(
            createCarrier({ ...input, ...patch }, deps)
        ).rejects.toThrow("invalid_carrier");
});
it("stores all assets and snake_case fields", async () => {
    expect(await createCarrier(input, deps)).toEqual({ id: 3 });
    expect(deps.store.createCarrier).toHaveBeenCalledWith(
        expect.objectContaining({
            legal_name: input.legalName,
            fee_bp: 500,
            driverIds: [1],
            truckIds: [2],
        })
    );
});
it("rejects another carrier's asset", async () => {
    deps.store.findCarrierByAsset.mockResolvedValue({ id: 4 });
    await expect(createCarrier(input, deps)).rejects.toThrow("asset_conflict");
});
it("ensures a customer once and emails hosted setup", async () => {
    await sendSetupLink(3, "primary", deps);
    await sendSetupLink(3, "backup", deps);
    expect(deps.stripe.ensureCustomer).toHaveBeenCalledTimes(1);
    expect(deps.stripe.createSetupSession).toHaveBeenCalledWith(
        expect.objectContaining({
            successUrl: expect.stringMatching(
                /^https:\/\/iron-wing-dispatching.com/
            ),
            cancelUrl: expect.stringMatching(
                /^https:\/\/iron-wing-dispatching.com/
            ),
        })
    );
    expect(deps.emailClient).toHaveBeenCalledWith(
        input.email,
        expect.any(String),
        expect.stringContaining("https://checkout.stripe.com/test")
    );
});
it("rejects unknown roles before calls", async () => {
    await expect(sendSetupLink(3, "other", deps)).rejects.toThrow(
        "invalid_role"
    );
    expect(deps.stripe.ensureCustomer).not.toHaveBeenCalled();
});

it("records an explicit initial backlog ownership date", async () => {
    await createCarrier({ ...input, effectiveFrom: "2026-11-01" }, deps);
    expect(deps.store.createCarrier).toHaveBeenCalledWith(
        expect.objectContaining({
            effectiveFrom: new Date("2026-11-01T00:00:00Z"),
        })
    );
    await expect(
        createCarrier({ ...input, effectiveFrom: "2026-02-30" }, deps)
    ).rejects.toThrow("invalid_carrier");
});
