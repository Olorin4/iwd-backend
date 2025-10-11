import express from "express";
import dotenvFlow from "dotenv-flow";
import router from "./router.js";
import morgan from "morgan";
import { configureSecurity } from "./security.js";
import { configureLogging, logger } from "./logging.js";

dotenvFlow.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Apply security configurations
configureSecurity(app);
// Apply logging configurations
configureLogging(app);

// Global Middleware
app.use(express.json());
app.use(limiter);
app.set("trust proxy", "loopback");
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router); // Register all routes AFTER applying middleware

// Log security events
app.use((req, res, next) => {
    req.logger.info({
        message: "Security Event",
        method: req.method,
        route: req.originalUrl,
        ip: req.ip,
    });
    next();
});

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

// Replace console logs with Winston
app.use((req, res, next) => {
    req.logger = logger;
    next();
});

// Start Server
app.listen(PORT, "0.0.0.0", () =>
    logger.info(`Iron Wing Server running at http://0.0.0.0:${PORT}`)
);

export { app, PORT };
