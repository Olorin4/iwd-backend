// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { getInterimBillingConfig } from "./config.js";
import { createStripeClient } from "./stripeClient.js";
import * as store from "./store.js";
import { fetchLoads } from "./kelevoReader.js";
import { emailClient, sendEmail } from "../emailService.js";
import { logger } from "../logging.js";
import { createInterimBillingRouter } from "./routes.js";
import { startScheduler, reconcileOnStart } from "./scheduler.js";
export { interimBillingRawBody } from "./webhook.js";
let dependencies;
function getDeps() {
    const config = getInterimBillingConfig();
    if (!dependencies)
        dependencies = {
            config,
            stripe: config.enabled ? createStripeClient(config.stripe) : null,
            store,
            fetchLoads,
            emailClient,
            sendEmail,
            logger,
        };
    return dependencies;
}
export const interimBillingRouter = createInterimBillingRouter(
    getInterimBillingConfig,
    getDeps
);
export async function startInterimBilling({
    getConfig = getInterimBillingConfig,
} = {}) {
    let config;
    try {
        config = getConfig();
    } catch {
        logger.error({ code: "interim_billing_config_invalid" });
        return;
    }
    if (!config.enabled) return;
    logger.info({ code: "interim_billing_started", mode: config.mode });
    const deps = getDeps(),
        scheduler = startScheduler(deps);
    try {
        await reconcileOnStart(deps);
    } catch {
        logger.error({ code: "interim_billing_recovery_pending" });
    }
    return scheduler;
}
