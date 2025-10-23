import express from "express";
import {
    getAllSignUpForms,
    getAllContactForms,
    signUpForm,
    contactForm,
    validateSignUpForm,
    sanitizeSignUpForm,
    validateContactForm,
    sanitizeContactForm,
    logRequestBody,
} from "./formsController.js";

const router = express.Router();

// Routes for Sign-Up & Contact Forms from iron-wing-dispatching.com
router
    .route("/sign-up-forms")
    .post(logRequestBody, validateSignUpForm, sanitizeSignUpForm, signUpForm)
    .get(getAllSignUpForms);

router
    .route("/contact-forms")
    .post(validateContactForm, sanitizeContactForm, contactForm)
    .get(getAllContactForms);

// Health check route
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
