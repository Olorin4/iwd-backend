import dotenv from "dotenv";
import { prisma } from "./prismaClient.js";
import { emailClient, emailAdmin } from "./emailService.js";
import { body, validationResult } from "express-validator";
import { attributionOf, recordAfterResponse } from "./formConversions.js";
import { logger } from "./logging.js";

dotenv.config();

// Form contents are personal data, so logs carry record ids, field names and
// error codes only.
const fieldsOf = (errors) => errors.array().map((e) => e.path ?? e.param);
const errorInfo = (error) => ({ name: error?.name, code: error?.code });

const validateSignUpForm = [
    body("firstName").trim().notEmpty().withMessage("First name is required."),
    body("lastName").trim().notEmpty().withMessage("Last name is required."),
    body("email").isEmail().withMessage("Invalid email address."),
    body("phone").trim(),
    body("fleetSize").trim().notEmpty().withMessage("Fleet size is required."),
    body("trailerType")
        .trim()
        .notEmpty()
        .withMessage("Trailer type is required."),
    body("plan").trim().notEmpty().withMessage("Plan is required."),
];

const validateContactForm = [
    body("email").isEmail().withMessage("Invalid email address."),
    body("message").trim().notEmpty().withMessage("Message is required."),
];

// Values are stored as typed. Prisma parameterises every query, and anything
// shown as HTML (the emails) is escaped when it is built.
const sanitizeSignUpForm = [
    body("firstName").trim(),
    body("lastName").trim(),
    body("email").normalizeEmail(),
    body("phone").trim(),
    body("fleetSize").trim(),
    body("trailerType").trim(),
    body("plan").trim(),
];

const sanitizeContactForm = [
    body("email").normalizeEmail(),
    body("phone").trim(),
    body("message").trim(),
];

async function signUpForm(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        logger.warn("Sign-up form failed validation", {
            fields: fieldsOf(errors),
        });
        return res.status(400).json({ errors: errors.array() });
    }

    const { firstName, lastName, email, phone, fleetSize, trailerType, plan } =
        req.body;

    if (
        !firstName ||
        !lastName ||
        !email ||
        !fleetSize ||
        !trailerType ||
        !plan
    ) {
        logger.warn("Sign-up form is missing required fields");
        return res.status(400).json({ error: "All fields are required." });
    }

    const { identityEmail, attribution } = attributionOf(res);

    try {
        const result = await prisma.signUpForm.create({
            data: {
                first_name: firstName,
                last_name: lastName,
                email,
                phone,
                fleet_size: fleetSize,
                trailer_type: trailerType,
                plan,
                status: "pending", // Default status
                outreach_ref: attribution.outreachRef,
                posthog_distinct_id: attribution.posthogDistinctId,
            },
        });
        logger.info("Sign-up form saved", { id: result.id });

        res.status(200).json({
            message: "Form submitted successfully!",
            id: result.id,
        });

        recordAfterResponse({
            type: "sign_up",
            leadId: result.id,
            identityEmail,
            attribution,
            properties: {
                plan,
                fleet_size: Number(fleetSize) || null,
                trailer_type: trailerType,
                has_phone: Boolean(phone),
            },
        });
    } catch (error) {
        logger.error("Sign-up form could not be saved", errorInfo(error));
        return res.status(500).json({ error: "Internal Server Error" });
    }

    try {
        await emailClient(
            email,
            "Thank You for Signing Up!",
            `Hello ${firstName},\n\nThank you for signing up with Iron Wing Dispatching. We will contact you shortly.`
        );

        await emailAdmin(
            "🚛 New Sign-Up Form Received",
            [
                "A new sign-up form has been received. Reply to this email to answer the carrier.",
                "",
                `Name: ${firstName} ${lastName}`,
                `Email: ${email}`,
                `Phone: ${phone || "(none)"}`,
                `Fleet size: ${fleetSize}`,
                `Trailer type: ${trailerType}`,
                `Plan: ${plan}`,
                "",
                `Submitted at: ${new Date().toISOString()}`,
            ].join("\n"),
            { replyTo: email }
        );
    } catch (emailError) {
        logger.error("Sign-up emails failed", errorInfo(emailError));
    }
}

async function contactForm(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, phone, message } = req.body;

    const { identityEmail, attribution } = attributionOf(res);

    try {
        // Built field by field so no other body key can reach the database.
        const result = await prisma.contactSubmission.create({
            data: {
                email,
                phone,
                message,
                outreach_ref: attribution.outreachRef,
                posthog_distinct_id: attribution.posthogDistinctId,
            },
        });
        logger.info("Contact form saved", { id: result.id });
        res.status(200).json({
            message: "Contact form submitted successfully!",
            id: result.id,
        });

        recordAfterResponse({
            type: "contact",
            leadId: result.id,
            identityEmail,
            attribution,
            properties: { has_phone: Boolean(phone) },
        });
    } catch (error) {
        logger.error("Contact form could not be saved", errorInfo(error));
        res.status(500).json({ error: "Internal Server Error" });
    }

    try {
        await emailClient(
            email,
            "Thank You for contacting us!",
            `Hello,\n\nThank you for contacting Iron Wing Dispatching. We will reach out soon.`
        );

        await emailAdmin(
            "🚛 New Contact Form submission",
            [
                "A visitor submitted a question. Reply to this email to answer them.",
                "",
                `Email: ${email}`,
                `Phone: ${phone || "(none)"}`,
                "Message:",
                message,
                "",
                `Submitted at: ${new Date().toISOString()}`,
            ].join("\n"),
            { replyTo: email }
        );
    } catch (emailError) {
        logger.error("Contact form emails failed", errorInfo(emailError));
    }
}

async function getAllSignUpForms(req, res) {
    try {
        const result = await prisma.signUpForm.findMany({
            take: 50,
            skip: 0,
        });
        logger.info("Sign-up forms listed", { count: result.length });
        res.status(200).json(result);
    } catch (error) {
        logger.error("Sign-up forms could not be listed", errorInfo(error));
        res.status(500).json({ error: "Internal Server Error" });
    }
}

async function getAllContactForms(req, res) {
    try {
        const result = await prisma.contactSubmission.findMany({
            take: 50,
            skip: 0,
        });
        logger.info("Contact forms listed", { count: result.length });
        res.status(200).json(result);
    } catch (error) {
        logger.error("Contact forms could not be listed", errorInfo(error));
        res.status(500).json({ error: "Internal Server Error" });
    }
}

export {
    validateSignUpForm,
    validateContactForm,
    sanitizeSignUpForm,
    sanitizeContactForm,
    signUpForm,
    contactForm,
    getAllSignUpForms,
    getAllContactForms,
};
