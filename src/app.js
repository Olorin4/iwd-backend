// src/app.js

import express from "express";
import dotenv from "dotenv-flow";
import sessionMiddleware from "./config/session.js";
import passport from "./config/passport.js";
import router from "./routes/router.js";

dotenv.config();
console.log("Database URL:", process.env.DB_URL);
const app = express();
const PORT = process.env.PORT || 3000;

// Global Middleware
app.use(express.json());
app.use(sessionMiddleware); // Apply session middleware globally
app.use(passport.initialize()); // Initialize Passport globally
app.use(passport.session()); // Enable session handling for authenticated users

app.set("trust proxy", true);
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router); // Register all routes AFTER applying middleware

// Fallback Route for Not Found
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Internal Server Error" });
});

// Start Server
app.listen(PORT, "0.0.0.0", () =>
    console.log(`Iron Wing Server running at http://0.0.0.0:${PORT}`)
);
