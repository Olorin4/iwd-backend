// Public interface of the permanent onboarding module (design §2, §6–§8).
// Never imports interim billing; see __tests__/onboarding/architecture.test.js.
import { prisma } from "../prismaClient.js";
import { logger } from "../logging.js";
import { sendEmail } from "../emailService.js";
import { getOnboardingConfig } from "./config.js";
import { createOnboardingDeps } from "./deps.js";
import { createOnboardingRouter, onboardingRawBody } from "./routes.js";
import { createPortalRouter } from "./portal/routes.js";
import { limiter } from "../rateLimiter.js";
import { startOnboardingWorkers } from "./workers.js";

let cached;
function getDeps(config) {
    if (!cached || cached.config !== config)
        cached = createOnboardingDeps(config, {
            db: prisma,
            logger,
            sendEmail,
        });
    return cached;
}

let lastConfig;
function getConfig() {
    // Parse once; settings change only with a restart.
    if (!lastConfig) lastConfig = getOnboardingConfig();
    return lastConfig;
}

export { onboardingRawBody, getOnboardingConfig };
export function onboardingPortalRouter() {
    return createPortalRouter(getConfig, getDeps, {
        baseUrl: process.env.ONBOARDING_PORTAL_BASE_URL,
        rateLimit: limiter,
    });
}

export const onboardingRouter = createOnboardingRouter(getConfig, getDeps);

/**
 * Starts onboarding background workers. Off unless ONBOARDING_ENABLED=1;
 * the outbox also needs OUTREACH_STATUS_URL/TOKEN/SIGNING_SECRET and the
 * reconciler ONBOARDING_RECONCILE_ENABLED=1.
 */
export function startOnboarding() {
    let config;
    try {
        config = getConfig();
    } catch {
        logger.error({ code: "onboarding_config_invalid" });
        return null;
    }
    if (!config.enabled) return null;
    return startOnboardingWorkers(getDeps(config));
}
