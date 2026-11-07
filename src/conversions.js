import { logger } from "./logging.js";
import { captureConversion } from "./posthogServer.js";
import { notifyOutreach } from "./outreachWebhook.js";

const CONVERSIONS = {
    sign_up: {
        event: "lead_signed_up",
        tier: "primary",
        // Allowlist: PostHog must never receive names, phone numbers or
        // message text, so only these keys get through from the caller.
        allowedProperties: ["plan", "fleet_size", "trailer_type", "has_phone"],
    },
    contact: {
        event: "contact_requested",
        tier: "secondary",
        allowedProperties: ["has_phone"],
    },
    newsletter: {
        event: "newsletter_subscribed_server",
        tier: "secondary",
        allowedProperties: [],
    },
};

function pick(source, keys) {
    const picked = {};
    if (!source || typeof source !== "object") return picked;
    for (const key of keys) {
        if (source[key] !== undefined) picked[key] = source[key];
    }
    return picked;
}

/**
 * Record a website form submission as a server-side PostHog event and tell
 * Outreach about it. Called after the visitor has already been answered, so it
 * never rejects or throws: each step's failure is logged and the next step
 * still runs.
 */
async function recordConversion({
    type,
    leadId,
    identityEmail,
    attribution,
    properties,
}) {
    const config = CONVERSIONS[type];
    const outreachRef = attribution?.outreachRef ?? null;
    const posthogDistinctId = attribution?.posthogDistinctId ?? null;

    try {
        if (!config) throw new Error(`Unknown conversion type: ${type}`);
        captureConversion({
            event: config.event,
            identityEmail,
            posthogDistinctId,
            outreachRef,
            properties: {
                ...pick(properties, config.allowedProperties),
                form: type,
                source: "server",
                conversion_tier: config.tier,
                ...(outreachRef ? { outreach_ref: outreachRef } : {}),
                deployment_environment:
                    process.env.NODE_ENV === "production"
                        ? "production"
                        : "development",
            },
        });
    } catch (error) {
        logger.error("PostHog conversion capture failed", {
            type,
            leadId,
            error: error?.message,
        });
    }

    try {
        await notifyOutreach({
            type,
            outreachRef,
            email: identityEmail,
            leadId,
        });
    } catch (error) {
        logger.error("Outreach conversion notification failed", {
            type,
            leadId,
            error: error?.message,
        });
    }
}

export { recordConversion };
