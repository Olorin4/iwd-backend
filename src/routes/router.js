// src/routes/router.js

import express from "express";
import { submitForm, contactForm } from "../controllers/handler.js";
import {
    getAllSignUpForms,
    getAllContactSubmissions,
} from "../models/dataModel.js";

const router = express.Router();

// Routes for Sign-Up Forms
router.route("/sign-up-forms").post(submitForm).get(getAllSignUpForms);

// Routes for Contact Submissions
router
    .route("/contact-submissions")
    .post(contactForm)
    .get(getAllContactSubmissions);

// Example of other grouped routes (optional)
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
