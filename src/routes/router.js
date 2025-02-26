// src/routes/router.js

import express from "express";
import { submitForm, contactForm } from "../controllers/handler.js";

const router = express.Router();

// Grouped Routes for Sign-Up Forms
router.post("/submit-form", submitForm);

// Grouped Routes for Contact Forms
router.post("/contact-form", contactForm);

// Example of other grouped routes (optional)
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
