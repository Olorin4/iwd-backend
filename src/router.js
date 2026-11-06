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
import { attributionFields } from "./attribution.js";

const router = express.Router();

// Every public POST below must carry a valid Cloudflare Turnstile token
// (`turnstileToken` in the JSON body). requireTurnstile runs first so nothing
// is logged, validated or stored for a request that fails the bot check.
// attributionFields follows it, ahead of the sanitizers, to capture the typed
// email and the optional attribution fields.

// Routes for Sign-Up & Contact Forms from iron-wing-dispatching.com
router
    .route("/sign-up-forms")
    .post(
        requireTurnstile,
        attributionFields,
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
        attributionFields,
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
    attributionFields,
    validateNewsletter,
    sanitizeNewsletter,
    newsletterSignup
);

// Health check route
router.get("/health-check", (req, res) => res.json({ status: "OK" }));

export default router;
