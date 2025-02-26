// src/app.js

import dotenv from "dotenv-flow";
import express from "express";
import router from "./routes/router.js";
import DataModel from "./models/dataModel.js";

dotenv.config();
console.log("Database URL:", process.env.DATABASE_URL);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.set("trust proxy", true);
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router);

// Route to Test Database Connection
app.get("/api/signup-forms", async (req, res) => {
    try {
        const forms = await DataModel.getAllSignUpForms();
        res.json(forms);
    } catch (error) {
        res.status(500).json({ error: "Failed to retrieve sign-up forms." });
    }
});

// Fallback Route for Not Found
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
// Error Handling Middleware (optional)
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Internal Server Error" });
});

// Start Server
app.listen(PORT, "0.0.0.0", () =>
    console.log(`Server running at http://0.0.0.0:${PORT}`)
);
