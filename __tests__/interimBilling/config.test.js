// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    getInterimBillingConfig,
    InterimBillingConfigError,
} from "../../src/interimBilling/config";

const TOKEN = "t".repeat(40);

function sandboxEnv(extra = {}) {
    return {
        INTERIM_BILLING_ENABLED: "true",
        INTERIM_BILLING_MODE: "sandbox",
        INTERIM_BILLING_START_DATE: "2026-11-23",
        INTERIM_BILLING_ADMIN_TOKEN: TOKEN,
        INTERIM_BILLING_ADMIN_EMAIL: "admin@example.com",
        INTERIM_BILLING_PRODUCT_ID: "prod_test",
        INTERIM_BILLING_STRIPE_WEBHOOK_SECRET: "whsec_test",
        INTERIM_BILLING_KELEVO_SSH_HOST: "100.64.0.1",
        INTERIM_BILLING_KELEVO_SSH_USER: "iwdbilling",
        INTERIM_BILLING_KELEVO_SSH_KEY_FILE: "/run/interim-billing/key",
        INTERIM_BILLING_KELEVO_SSH_KNOWN_HOSTS_FILE:
            "/run/interim-billing/known_hosts",
        STRIPE_SANDBOX_SECRET_KEY: "sk_test_abc",
        ...extra,
    };
}

describe("getInterimBillingConfig", () => {
    it("returns only { enabled: false } when the module is off, without validating anything else", () => {
        expect(getInterimBillingConfig({})).toEqual({ enabled: false });
        expect(
            getInterimBillingConfig({
                INTERIM_BILLING_ENABLED: "false",
                INTERIM_BILLING_MODE: "nonsense",
            })
        ).toEqual({ enabled: false });
    });

    it("accepts a sandbox config and applies the defaults", () => {
        const config = getInterimBillingConfig(sandboxEnv());
        expect(config.enabled).toBe(true);
        expect(config.mode).toBe("sandbox");
        expect(config.timezone).toBe("America/Chicago");
        expect(config.runHour).toBe(6);
        expect(config.autoRun).toBe(false);
        expect(config.startDate).toEqual(new Date("2026-11-23T00:00:00Z"));
        expect(config.stripe.apiVersion).toBe("2026-10-28.endive");
        expect(config.stripe.secretKey).toBe("sk_test_abc");
        expect(config.loadsFile).toBeNull();
    });

    it("accepts a restricted test key in sandbox mode", () => {
        const config = getInterimBillingConfig(
            sandboxEnv({ STRIPE_SANDBOX_SECRET_KEY: "rk_test_abc" })
        );
        expect(config.stripe.secretKey).toBe("rk_test_abc");
    });

    it("rejects a live key in sandbox mode, without echoing the key", () => {
        const env = sandboxEnv({
            STRIPE_SANDBOX_SECRET_KEY: "sk_live_secret99",
        });
        expect(() => getInterimBillingConfig(env)).toThrow(
            InterimBillingConfigError
        );
        try {
            getInterimBillingConfig(env);
        } catch (error) {
            expect(error.message).not.toContain("secret99");
        }
    });

    it("rejects a missing sandbox key", () => {
        const env = sandboxEnv();
        delete env.STRIPE_SANDBOX_SECRET_KEY;
        expect(() => getInterimBillingConfig(env)).toThrow(
            InterimBillingConfigError
        );
    });

    it("rejects an invalid mode", () => {
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_MODE: "prod" })
            )
        ).toThrow(InterimBillingConfigError);
    });

    it("live mode needs LIVE_CONFIRM=yes", () => {
        const env = sandboxEnv({
            INTERIM_BILLING_MODE: "live",
            STRIPE_LIVE_SECRET_KEY: "rk_live_abc",
        });
        expect(() => getInterimBillingConfig(env)).toThrow(
            InterimBillingConfigError
        );
        expect(
            getInterimBillingConfig({
                ...env,
                INTERIM_BILLING_LIVE_CONFIRM: "yes",
            }).mode
        ).toBe("live");
    });

    it("live mode rejects anything but a restricted live key", () => {
        for (const key of ["sk_live_abc", "sk_test_abc", "rk_test_abc", ""]) {
            expect(() =>
                getInterimBillingConfig(
                    sandboxEnv({
                        INTERIM_BILLING_MODE: "live",
                        INTERIM_BILLING_LIVE_CONFIRM: "yes",
                        STRIPE_LIVE_SECRET_KEY: key,
                    })
                )
            ).toThrow(InterimBillingConfigError);
        }
    });

    it("requires a start date", () => {
        const env = sandboxEnv();
        delete env.INTERIM_BILLING_START_DATE;
        expect(() => getInterimBillingConfig(env)).toThrow(
            InterimBillingConfigError
        );
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_START_DATE: "yesterday" })
            )
        ).toThrow(InterimBillingConfigError);
    });

    it("rejects an admin token under 32 characters", () => {
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_ADMIN_TOKEN: "short" })
            )
        ).toThrow(InterimBillingConfigError);
    });

    it("allows the sandbox loads file only in sandbox mode", () => {
        expect(
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_LOADS_FILE: "/tmp/loads.json" })
            ).loadsFile
        ).toBe("/tmp/loads.json");
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({
                    INTERIM_BILLING_MODE: "live",
                    INTERIM_BILLING_LIVE_CONFIRM: "yes",
                    STRIPE_LIVE_SECRET_KEY: "rk_live_abc",
                    INTERIM_BILLING_LOADS_FILE: "/tmp/loads.json",
                })
            )
        ).toThrow(InterimBillingConfigError);
    });

    it("rejects an unknown time zone and a run hour outside 0-23", () => {
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_TIMEZONE: "Mars/Olympus" })
            )
        ).toThrow(InterimBillingConfigError);
        expect(() =>
            getInterimBillingConfig(
                sandboxEnv({ INTERIM_BILLING_RUN_HOUR: "24" })
            )
        ).toThrow(InterimBillingConfigError);
    });
});
