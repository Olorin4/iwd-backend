// src/app.js

import express from "express";
import dotenv from "dotenv-flow";
import router from "./routes/router.js";

dotenv.config();
console.log("Database URL:", process.env.DB_URL);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.set("trust proxy", true);
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router);

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
