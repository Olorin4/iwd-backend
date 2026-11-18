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
    ONBOARDING_COUNTERSIGNER_TITLE: "Dispatch Manager",
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
    expect(config.signature.calibration).toEqual({
        scale: 4 / 3,
        offsetX: 0,
        offsetY: 0,
    });
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

it("accepts one optional requester email and refuses lists or junk", () => {
    expect(getOnboardingConfig(base).signature.requesterEmail).toBeNull();
    expect(
        getOnboardingConfig({
            ...base,
            ONBOARDING_REQUESTER_EMAIL: "onboarding@example.test",
        }).signature.requesterEmail
    ).toBe("onboarding@example.test");
    for (const bad of [
        "a@example.test,b@example.test",
        "not-an-email",
        "Name <a@example.test>",
    ])
        expect(() =>
            getOnboardingConfig({ ...base, ONBOARDING_REQUESTER_EMAIL: bad })
        ).toThrow(/ONBOARDING_REQUESTER_EMAIL/);
});

it("validates the Iron Wing fallback email delay (0-60 minutes, default 60)", () => {
    const delay = (value) =>
        getOnboardingConfig({
            ...base,
            ONBOARDING_IRON_WING_EMAIL_DELAY_MINUTES: value,
        }).signature.ironWingEmailDelayMinutes;
    expect(getOnboardingConfig(base).signature.ironWingEmailDelayMinutes).toBe(
        60
    );
    expect(delay("")).toBe(60);
    expect(delay("0")).toBe(0);
    expect(delay("15")).toBe(15);
    expect(delay("60")).toBe(60);
    for (const bad of ["61", "-1", "1.5", "abc", "1e3"])
        expect(() => delay(bad)).toThrow(
            /ONBOARDING_IRON_WING_EMAIL_DELAY_MINUTES/
        );
});

it("in production allows http for OUTREACH_STATUS_URL only on an internal Docker service name", () => {
    const prod = {
        ...base,
        NODE_ENV: "production",
        ONBOARDING_PUBLIC_BASE_URL: "https://api.example.test",
        ONBOARDING_STRIPE_SUCCESS_URL: "https://api.example.test/done",
        ONBOARDING_STRIPE_CANCEL_URL: "https://example.test/",
    };
    const withStatus = (url) => ({
        ...prod,
        OUTREACH_STATUS_URL: url,
        ONBOARDING_STATUS_TOKEN: "t".repeat(40),
        ONBOARDING_STATUS_SIGNING_SECRET: "u".repeat(40),
    });
    expect(
        getOnboardingConfig(
            withStatus("http://outreach:3012/internal/sales/onboarding-status")
        ).outbox.url
    ).toBe("http://outreach:3012/internal/sales/onboarding-status");
    expect(
        getOnboardingConfig(withStatus("https://outreach.example.test/x"))
            .outbox.enabled
    ).toBe(true);
    for (const bad of [
        "http://outreach.example.test/x",
        "http://10.0.0.5:3012/x",
        "http://localhost.evil.test/x",
    ])
        expect(() => getOnboardingConfig(withStatus(bad))).toThrow(
            /OUTREACH_STATUS_URL must use https/
        );
    // Other URLs keep requiring https in production.
    expect(() =>
        getOnboardingConfig({
            ...withStatus("http://outreach:3012/x"),
            ONBOARDING_PUBLIC_BASE_URL: "http://iwd-backend:3000",
        })
    ).toThrow(/ONBOARDING_PUBLIC_BASE_URL must use https/);
});
