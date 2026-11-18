// Settings for the permanent onboarding module. Errors name the setting, never
// its value. Everything is off unless ONBOARDING_ENABLED=1.

export const ONBOARDING_STRIPE_API_VERSION = "2026-10-28.endive";

export class OnboardingConfigError extends Error {
    constructor(message) {
        super(message);
        this.name = "OnboardingConfigError";
    }
}

function required(env, name, { min = 1 } = {}) {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    if (value.length < min)
        throw new OnboardingConfigError(
            min > 1
                ? `${name} must be at least ${min} characters.`
                : `${name} is required.`
        );
    return value;
}

/** One email address or null when unset (never a list). */
function optionalEmail(env, name) {
    const value = typeof env[name] === "string" ? env[name].trim() : "";
    if (!value) return null;
    if (
        value.length > 254 ||
        !/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(value)
    )
        throw new OnboardingConfigError(`${name} must be one email address.`);
    return value;
}

function httpsUrl(env, name, { allowHttp = false } = {}) {
    const value = required(env, name);
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new OnboardingConfigError(`${name} must be a URL.`);
    }
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
        throw new OnboardingConfigError(`${name} must use https.`);
    return value.replace(/\/+$/, "");
}

function positiveInt(env, name, fallback, max) {
    const raw = env[name];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > max)
        throw new OnboardingConfigError(
            `${name} must be a whole number from 1 to ${max}.`
        );
    return value;
}

function finiteNumber(env, name, fallback) {
    const raw = env[name];
    const value = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isFinite(value) || Math.abs(value) > 10000)
        throw new OnboardingConfigError(`${name} must be a number.`);
    return value;
}

export function parseDocumentKey(value) {
    const key = Buffer.from(String(value || ""), "base64");
    if (key.length !== 32)
        throw new OnboardingConfigError(
            "ONBOARDING_DOCUMENT_KEY must be 32 bytes, base64."
        );
    return key;
}

export function stripeKeyMode(env) {
    const key = required(env, "ONBOARDING_STRIPE_SECRET_KEY");
    if (/^(sk|rk)_test_/.test(key)) return { secretKey: key, live: false };
    if (
        /^(sk|rk)_live_/.test(key) &&
        env.ONBOARDING_STRIPE_LIVE_CONFIRM === "yes"
    )
        return { secretKey: key, live: true };
    throw new OnboardingConfigError(
        "ONBOARDING_STRIPE_SECRET_KEY must be a test key unless ONBOARDING_STRIPE_LIVE_CONFIRM=yes."
    );
}

export function getOnboardingConfig(env = process.env) {
    if (env.ONBOARDING_ENABLED !== "1") return { enabled: false };

    const serviceToken = required(env, "IWD_ONBOARDING_TOKEN", { min: 32 });
    const requestSigningSecret = required(
        env,
        "ONBOARDING_REQUEST_SIGNING_SECRET",
        { min: 32 }
    );
    if (serviceToken === requestSigningSecret)
        throw new OnboardingConfigError(
            "IWD_ONBOARDING_TOKEN and ONBOARDING_REQUEST_SIGNING_SECRET must differ."
        );
    const allowHttp = env.NODE_ENV !== "production";
    const provider = env.ONBOARDING_SIGNATURE_PROVIDER || "signwell";
    if (!["signwell", "fake"].includes(provider))
        throw new OnboardingConfigError(
            "ONBOARDING_SIGNATURE_PROVIDER must be signwell or fake."
        );
    if (provider === "fake" && env.NODE_ENV === "production")
        throw new OnboardingConfigError(
            "The fake signature provider is not allowed in production."
        );
    const adapter = env.ONBOARDING_PROVISIONING_ADAPTER || "manual";
    if (!["manual", "kelevo"].includes(adapter))
        throw new OnboardingConfigError(
            "ONBOARDING_PROVISIONING_ADAPTER must be manual or kelevo."
        );

    const stripe = stripeKeyMode(env);
    const outboxConfigured = !!(
        env.OUTREACH_STATUS_URL &&
        env.ONBOARDING_STATUS_TOKEN &&
        env.ONBOARDING_STATUS_SIGNING_SECRET
    );

    return {
        enabled: true,
        serviceToken,
        requestSigningSecret,
        publicBaseUrl: httpsUrl(env, "ONBOARDING_PUBLIC_BASE_URL", {
            allowHttp,
        }),
        continueSecret: required(env, "ONBOARDING_CONTINUE_TOKEN_SECRET", {
            min: 32,
        }),
        continueTtlSeconds:
            positiveInt(env, "ONBOARDING_CONTINUE_TTL_DAYS", 30, 90) * 86400,
        documents: {
            dir: required(env, "ONBOARDING_DOCUMENT_DIR"),
            key: parseDocumentKey(env.ONBOARDING_DOCUMENT_KEY),
        },
        bundleName: env.ONBOARDING_BUNDLE_NAME || "iron-wing-carrier-client",
        signature: {
            provider,
            apiKey:
                provider === "signwell"
                    ? required(env, "SIGNWELL_API_KEY")
                    : null,
            webhookId:
                provider === "signwell"
                    ? required(env, "SIGNWELL_WEBHOOK_ID")
                    : "fake-webhook-id",
            testMode: !["0", "false", "no"].includes(
                String(
                    env.ONBOARDING_SIGNWELL_TEST_MODE ?? "true"
                ).toLowerCase()
            ),
            expiresInDays: positiveInt(
                env,
                "ONBOARDING_SIGNWELL_EXPIRES_IN_DAYS",
                14,
                365
            ),
            timeoutMs: positiveInt(
                env,
                "ONBOARDING_SIGNWELL_TIMEOUT_MS",
                15000,
                120000
            ),
            requesterEmail: optionalEmail(env, "ONBOARDING_REQUESTER_EMAIL"),
            countersigner: {
                name: required(env, "ONBOARDING_COUNTERSIGNER_NAME"),
                title: required(env, "ONBOARDING_COUNTERSIGNER_TITLE"),
                email: required(env, "ONBOARDING_COUNTERSIGNER_EMAIL"),
            },
            calibration: {
                // Calibrated 2026-11-18: points × 4/3, top-left origin.
                scale: finiteNumber(
                    env,
                    "ONBOARDING_SIGNWELL_COORD_SCALE",
                    4 / 3
                ),
                offsetX: finiteNumber(
                    env,
                    "ONBOARDING_SIGNWELL_COORD_OFFSET_X",
                    0
                ),
                offsetY: finiteNumber(
                    env,
                    "ONBOARDING_SIGNWELL_COORD_OFFSET_Y",
                    0
                ),
            },
        },
        stripe: {
            ...stripe,
            webhookSecret: required(env, "ONBOARDING_STRIPE_WEBHOOK_SECRET"),
            successUrl: httpsUrl(env, "ONBOARDING_STRIPE_SUCCESS_URL", {
                allowHttp,
            }),
            cancelUrl: httpsUrl(env, "ONBOARDING_STRIPE_CANCEL_URL", {
                allowHttp,
            }),
            apiVersion: ONBOARDING_STRIPE_API_VERSION,
        },
        provisioning: { adapter },
        outbox: {
            enabled: outboxConfigured,
            url: outboxConfigured
                ? httpsUrl(env, "OUTREACH_STATUS_URL", { allowHttp })
                : null,
            token: env.ONBOARDING_STATUS_TOKEN || null,
            signingSecret: env.ONBOARDING_STATUS_SIGNING_SECRET || null,
            intervalMs: 30000,
        },
        reconcile: {
            enabled: env.ONBOARDING_RECONCILE_ENABLED === "1",
            intervalMs: 15 * 60 * 1000,
        },
        email: { from: env.ONBOARDING_EMAIL_FROM || env.EMAIL_USER || null },
    };
}
