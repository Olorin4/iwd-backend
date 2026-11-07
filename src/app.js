import express from "express";
import dotenvFlow from "dotenv-flow";
import router from "./router.js";
import { configureSecurity } from "./security.js";
import { configureLogging, logger } from "./logging.js";
import { shutdownPosthog } from "./posthogServer.js";
import { registerShutdown } from "./shutdown.js";

dotenvFlow.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Global Middleware
app.use(express.json());
// The API sits behind exactly one proxy hop: the containerized nginx edge,
// which sets the real client IP (from Cloudflare's CF-Connecting-IP) as the
// last X-Forwarded-For entry. Trusting one hop makes req.ip the real client, so
// rate limits apply per visitor instead of to the proxy's address. Rate
// limiting itself is applied once, in configureSecurity.
app.set("trust proxy", 1);

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
    req.logger.error({
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

// Flush queued PostHog events before the container stops.
registerShutdown(process, shutdownPosthog);

export { app, PORT };
