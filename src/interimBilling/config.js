// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
//
// Settings for the interim weekly billing module, with the guards that keep
// sandbox and live money apart. Nothing here ever puts a key in an error.

export const STRIPE_API_VERSION = "2026-10-28.endive";

export class InterimBillingConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "InterimBillingConfigError";
    }
}

const isTrue = (value) => String(value || "").toLowerCase() === "true";

function requireValue(env, name) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") {
        throw new InterimBillingConfigError(`${name} is required.`);
    }
    return value.trim();
}

function parseTimeZone(value) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value });
        return value;
    } catch {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_TIMEZONE is not a valid time zone."
        );
    }
}

function parseRunHour(value) {
    const hour = value === undefined || value === "" ? 6 : Number(value);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_RUN_HOUR must be a whole number from 0 to 23."
        );
    }
    return hour;
}

function parseStartDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_START_DATE must be a date like 2026-11-23."
        );
    }
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_START_DATE is not a real date."
        );
    }
    return date;
}

function pickStripeKey(env, mode) {
    if (mode === "sandbox") {
        const key = env.STRIPE_SANDBOX_SECRET_KEY || "";
        if (!/^(sk|rk)_test_/.test(key)) {
            throw new InterimBillingConfigError(
                "Sandbox mode needs STRIPE_SANDBOX_SECRET_KEY to be a test key."
            );
        }
        return key;
    }
    if (env.INTERIM_BILLING_LIVE_CONFIRM !== "yes") {
        throw new InterimBillingConfigError(
            "Live mode needs INTERIM_BILLING_LIVE_CONFIRM=yes."
        );
    }
    const key = env.STRIPE_LIVE_SECRET_KEY || "";
    if (!/^rk_live_/.test(key)) {
        throw new InterimBillingConfigError(
            "Live mode needs STRIPE_LIVE_SECRET_KEY to be a restricted live key."
        );
    }
    return key;
}

/**
 * Reads and validates the module's settings. When the module is off it
 * returns { enabled: false } and validates nothing else.
 */
export function getInterimBillingConfig(env = process.env) {
    if (!isTrue(env.INTERIM_BILLING_ENABLED)) return { enabled: false };

    const mode = env.INTERIM_BILLING_MODE;
    if (mode !== "sandbox" && mode !== "live") {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_MODE must be sandbox or live."
        );
    }

    const secretKey = pickStripeKey(env, mode);

    const adminToken = requireValue(env, "INTERIM_BILLING_ADMIN_TOKEN");
    if (adminToken.length < 32) {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_ADMIN_TOKEN must be at least 32 characters."
        );
    }

    const loadsFile = env.INTERIM_BILLING_LOADS_FILE || null;
    if (loadsFile && mode !== "sandbox") {
        throw new InterimBillingConfigError(
            "INTERIM_BILLING_LOADS_FILE is allowed only in sandbox mode."
        );
    }

    return {
        enabled: true,
        mode,
        timezone: parseTimeZone(
            env.INTERIM_BILLING_TIMEZONE || "America/Chicago"
        ),
        runHour: parseRunHour(env.INTERIM_BILLING_RUN_HOUR),
        startDate: parseStartDate(env.INTERIM_BILLING_START_DATE),
        autoRun: isTrue(env.INTERIM_BILLING_AUTO_RUN),
        ssh: {
            host: requireValue(env, "INTERIM_BILLING_KELEVO_SSH_HOST"),
            user: requireValue(env, "INTERIM_BILLING_KELEVO_SSH_USER"),
            keyFile: requireValue(env, "INTERIM_BILLING_KELEVO_SSH_KEY_FILE"),
            knownHostsFile: requireValue(
                env,
                "INTERIM_BILLING_KELEVO_SSH_KNOWN_HOSTS_FILE"
            ),
        },
        loadsFile,
        stripe: {
            secretKey,
            webhookSecret: requireValue(
                env,
                "INTERIM_BILLING_STRIPE_WEBHOOK_SECRET"
            ),
            productId: requireValue(env, "INTERIM_BILLING_PRODUCT_ID"),
            apiVersion: STRIPE_API_VERSION,
        },
        adminEmail: requireValue(env, "INTERIM_BILLING_ADMIN_EMAIL"),
        adminToken,
    };
}
