import express from "express";
import dotenvFlow from "dotenv-flow";
import router from "./router.js";
import { configureSecurity, limiter } from "./security.js";
import { configureLogging, logger } from "./logging.js";

dotenvFlow.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Global Middleware
app.use(express.json());
app.set("trust proxy", "loopback");
app.use(limiter);

// Apply security configurations
configureSecurity(app);
// Apply logging configurations
configureLogging(app);
app.get("/", (res) => res.send("Iron Wing API is working!"));

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

export { app, PORT };
