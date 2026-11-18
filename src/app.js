import express from "express";
import dotenvFlow from "dotenv-flow";
import router from "./router.js";
import { configureSecurity } from "./security.js";
import { configureLogging, logger } from "./logging.js";
import { shutdownPosthog } from "./posthogServer.js";
import { registerShutdown } from "./shutdown.js";

// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    interimBillingRawBody,
    startInterimBilling,
} from "./interimBilling/index.js";
import { isPortalPath } from "./onboarding/portal/hostGuard.js";
import {
    onboardingPortalRouter,
    onboardingRawBody,
    startOnboarding,
} from "./onboarding/index.js";

dotenvFlow.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Global Middleware
// Onboarding keeps the raw body for HMAC and webhook signatures; it parses
// first so the interim billing parser below is unchanged.
// The API sits behind exactly one proxy hop: the containerized nginx edge,
// which sets the real client IP (from Cloudflare's CF-Connecting-IP) as the
// last X-Forwarded-For entry. Trusting one hop makes req.ip the real client, so
// rate limits apply per visitor instead of to the proxy's address. Rate
// limiting itself is applied once, in configureSecurity.
app.set("trust proxy", 1);
app.use(onboardingPortalRouter());

app.use("/onboarding", express.json({ verify: onboardingRawBody }));
// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
app.use(express.json({ verify: interimBillingRawBody }));

// Apply logging configurations
configureLogging(app);
// Apply security configurations
configureSecurity(app);
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router); // Register all routes AFTER applying middleware

// Fallback Route for Not Found
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
// Error Handling Middleware
app.use((err, req, res, next) => {
    if (isPortalPath(req.originalUrl))
        logger.error({ message: "Portal request failed", route: "/p/[token]" });
    else
        (req.logger ?? logger).error({
            message: err.message,
            stack: err.stack,
            route: req.originalUrl,
        });
    res.status(500).json({ error: "Internal Server Error" });
});

// Start Server
app.listen(PORT, "0.0.0.0", () =>
    logger.info(`Iron Wing Server running at http://0.0.0.0:${PORT}`)
);

// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
void startInterimBilling();

// Onboarding workers; nothing starts unless ONBOARDING_ENABLED=1 and its switches.
startOnboarding();

// Flush queued PostHog events before the container stops.
registerShutdown(process, shutdownPosthog);

export { app, PORT };
