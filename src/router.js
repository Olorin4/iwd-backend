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
import { newsletterLimiter } from "./rateLimiter.js";
import { requireTurnstile } from "./turnstile.js";

const router = express.Router();

// Every public POST below must carry a valid Cloudflare Turnstile token
// (`turnstileToken` in the JSON body). requireTurnstile runs first so nothing
// is logged, validated or stored for a request that fails the bot check.

// Routes for Sign-Up & Contact Forms from iron-wing-dispatching.com
router
    .route("/sign-up-forms")
    .post(
        requireTurnstile,
        logRequestBody,
        validateSignUpForm,
        sanitizeSignUpForm,
        signUpForm
    )
    .get(requireAdmin, getAllSignUpForms);

router
    .route("/contact-forms")
    .post(
        requireTurnstile,
        validateContactForm,
        sanitizeContactForm,
        contactForm
    )
    .get(requireAdmin, getAllContactForms);

// Newsletter signup from the footer form on iron-wing-dispatching.com
router.post(
    "/newsletter",
    newsletterLimiter,
    requireTurnstile,
    validateNewsletter,
    sanitizeNewsletter,
    newsletterSignup
);

// Health check route
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
