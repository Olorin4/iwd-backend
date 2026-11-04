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
import {
    validateNewsletter,
    sanitizeNewsletter,
    newsletterSignup,
} from "./newsletterController.js";
import { requireAdmin } from "./adminAuth.js";
import { newsletterLimiter } from "./newsletterLimiter.js";

const router = express.Router();

// Routes for Sign-Up & Contact Forms from iron-wing-dispatching.com
router
    .route("/sign-up-forms")
    .post(logRequestBody, validateSignUpForm, sanitizeSignUpForm, signUpForm)
    .get(requireAdmin, getAllSignUpForms);

router
    .route("/contact-forms")
    .post(validateContactForm, sanitizeContactForm, contactForm)
    .get(requireAdmin, getAllContactForms);

// Newsletter signup from the footer form on iron-wing-dispatching.com
router.post(
    "/newsletter",
    newsletterLimiter,
    validateNewsletter,
    sanitizeNewsletter,
    newsletterSignup
);

// Health check route
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
