// Public interface of the permanent onboarding module (design §2, §6–§8).
// Never imports interim billing; see __tests__/onboarding/architecture.test.js.
import { prisma } from "../prismaClient.js";
import { logger } from "../logging.js";
import { sendEmail } from "../emailService.js";
import { getOnboardingConfig } from "./config.js";
import { createOnboardingDeps } from "./deps.js";
import { createOnboardingRouter, onboardingRawBody } from "./routes.js";

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
export const onboardingRouter = createOnboardingRouter(getConfig, getDeps);
