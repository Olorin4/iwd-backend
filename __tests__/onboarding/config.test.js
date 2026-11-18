import { getOnboardingConfig } from "../../src/onboarding/config";

const base = {
    ONBOARDING_ENABLED: "1",
    IWD_ONBOARDING_TOKEN: "t".repeat(40),
    ONBOARDING_REQUEST_SIGNING_SECRET: "s".repeat(40),
    ONBOARDING_PUBLIC_BASE_URL: "https://api.example.test",
    ONBOARDING_CONTINUE_TOKEN_SECRET: "c".repeat(40),
    ONBOARDING_DOCUMENT_DIR: "/var/lib/onboarding",
    ONBOARDING_DOCUMENT_KEY: Buffer.alloc(32, 7).toString("base64"),
    SIGNWELL_API_KEY: "sw-key",
    SIGNWELL_WEBHOOK_ID: "sw-hook",
    ONBOARDING_COUNTERSIGNER_NAME: "Dispatch Lead",
    ONBOARDING_COUNTERSIGNER_EMAIL: "dispatch@example.test",
    ONBOARDING_STRIPE_SECRET_KEY: "sk_test_abc",
    ONBOARDING_STRIPE_WEBHOOK_SECRET: "whsec_x",
    ONBOARDING_STRIPE_SUCCESS_URL: "https://example.test/done",
    ONBOARDING_STRIPE_CANCEL_URL: "https://example.test/cancel",
};

it("is off unless ONBOARDING_ENABLED=1", () => {
    expect(getOnboardingConfig({})).toEqual({ enabled: false });
    expect(
        getOnboardingConfig({ ...base, ONBOARDING_ENABLED: "true" })
    ).toEqual({ enabled: false });
});

it("parses a full configuration with safe defaults", () => {
    const config = getOnboardingConfig(base);
    expect(config.enabled).toBe(true);
    expect(config.signature.testMode).toBe(true);
    expect(config.reconcile.enabled).toBe(false);
    expect(config.outbox.enabled).toBe(false);
    expect(config.stripe.live).toBe(false);
    expect(config.provisioning.adapter).toBe("manual");
    expect(config.documents.key).toHaveLength(32);
});

it("refuses live Stripe keys without explicit confirmation", () => {
    expect(() =>
        getOnboardingConfig({
            ...base,
            ONBOARDING_STRIPE_SECRET_KEY: "sk_live_abc",
        })
    ).toThrow(/ONBOARDING_STRIPE_LIVE_CONFIRM/);
    expect(
        getOnboardingConfig({
            ...base,
            ONBOARDING_STRIPE_SECRET_KEY: "rk_live_abc",
            ONBOARDING_STRIPE_LIVE_CONFIRM: "yes",
        }).stripe.live
    ).toBe(true);
});

it("never puts a secret value in an error message", () => {
    const secret = "sk_live_supersecretvalue";
    try {
        getOnboardingConfig({ ...base, ONBOARDING_STRIPE_SECRET_KEY: secret });
    } catch (error) {
        expect(error.message).not.toContain(secret);
    }
    expect(() =>
        getOnboardingConfig({ ...base, ONBOARDING_DOCUMENT_KEY: "short" })
    ).toThrow("ONBOARDING_DOCUMENT_KEY must be 32 bytes, base64.");
});

it("requires distinct bearer and signing secrets and rejects the fake provider in production", () => {
    expect(() =>
        getOnboardingConfig({
            ...base,
            ONBOARDING_REQUEST_SIGNING_SECRET: "t".repeat(40),
        })
    ).toThrow(/must differ/);
    expect(() =>
        getOnboardingConfig({
            ...base,
            ONBOARDING_SIGNATURE_PROVIDER: "fake",
            NODE_ENV: "production",
        })
    ).toThrow(/fake/);
});

it("turns test mode off only explicitly and enables the outbox only when fully configured", () => {
    expect(
        getOnboardingConfig({ ...base, ONBOARDING_SIGNWELL_TEST_MODE: "false" })
            .signature.testMode
    ).toBe(false);
    const config = getOnboardingConfig({
        ...base,
        OUTREACH_STATUS_URL:
            "https://outreach.example.test/internal/sales/onboarding-status",
        ONBOARDING_STATUS_TOKEN: "o".repeat(40),
        ONBOARDING_STATUS_SIGNING_SECRET: "h".repeat(40),
        ONBOARDING_RECONCILE_ENABLED: "1",
    });
    expect(config.outbox.enabled).toBe(true);
    expect(config.reconcile.enabled).toBe(true);
});
