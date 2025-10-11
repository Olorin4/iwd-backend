import dotenv from "dotenv";
import { prisma } from "./prismaClient.js";
import { emailClient, emailAdmin } from "./emailService.js";
import { body, validationResult } from "express-validator";

dotenv.config();

const logRequestBody = (req, res, next) => {
    console.log("Request body before validation:", req.body);
    next();
};

const validateSignUpForm = [
    body("firstName").trim().notEmpty().withMessage("First name is required."),
    body("lastName").trim().notEmpty().withMessage("Last name is required."),
    body("email").isEmail().withMessage("Invalid email address."),
    body("phone").trim().notEmpty().withMessage("Phone number is required."),
    body("fleetSize").trim().notEmpty().withMessage("Fleet size is required."),
    body("trailerType").trim().notEmpty().withMessage("Trailer type is required."),
    body("plan").trim().notEmpty().withMessage("Plan is required."),
];

const validateContactForm = [
    body("email").isEmail().withMessage("Invalid email address."),
    body("message").trim().notEmpty().withMessage("Message is required."),
];

const sanitizeSignUpForm = [
    body("firstName").trim().escape(),
    body("lastName").trim().escape(),
    body("email").normalizeEmail(),
    body("phone").trim().escape(),
    body("fleetSize").trim().escape(),
    body("trailerType").trim().escape(),
    body("plan").trim().escape(),
];

const sanitizeContactForm = [
    body("email").normalizeEmail(),
    body("phone").trim().escape(),
    body("message").trim().escape(),
];

async function signUpForm(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        console.error("Validation errors:", errors.array());
        return res.status(400).json({ errors: errors.array() });
    }

    console.log("📩 Received Form Data:", req.body);

    const {
        firstName,
        lastName,
        email,
        phone,
        fleetSize,
        trailerType,
        plan,
    } = req.body;

    if (
        !firstName ||
        !lastName ||
        !email ||
        !phone ||
        !fleetSize ||
        !trailerType ||
        !plan
    ) {
        console.warn("⚠️ Missing required fields:", req.body);
        return res.status(400).json({ error: "All fields are required." });
    }

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
            },
        });
        console.log("✅ Inserted Sign-Up Form ID:", result.id);

        res.status(200).json({
            message: "Form submitted successfully!",
            id: result.id,
        });
    } catch (error) {
        console.error("❌ Prisma Error:", error);
        return res.status(500).json({ error: error.message });
    }

    try {
        await emailClient(
            email,
            "Thank You for Signing Up!",
            `Hello ${firstName},\n\nThank you for signing up with Iron Wing Dispatching. We will contact you shortly.\n\nAll the best,\nIron Wing Dispatching Team`
        );

        await emailAdmin(
            "🚛 New Sign-Up Form Received",
            `<pre>
        📩 A new sign-up form has been received!

        👤 Name: ${firstName} ${lastName}
        📧 Email: ${email}
        📞 Phone: ${phone}
        🚛 Fleet Size: ${fleetSize}
        🛻 Trailer Type: ${trailerType}
        📌 Plan Selected: ${plan}

        🕒 Submitted At: ${new Date().toLocaleString()}
        </pre>`
        );
    } catch (emailError) {
        console.error("❌ Email Error:", emailError);
    }
}

async function contactForm(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    const { email, phone, message } = req.body;

    console.log("📩 Contact Form Submission:", req.body);

    try {
        const result = await prisma.contactSubmission.create({
            data: req.body,
        });
        console.log("✅ Contact Form Inserted ID:", result.id);
        res.status(200).json({
            message: "Contact form submitted successfully!",
            id: result.id,
        });
    } catch (error) {
        console.error("❌ Prisma Error:", error);
        res.status(500).json({ error: error.message });
    }

    try {
        await emailClient(
            email,
            "Thank You for contacting us!",
            `Hello,\n\nThank you for contacting Iron Wing Dispatching. We will reach out soon.\n\nAll the best,\nIron Wing Dispatching Team`
        );

        await emailAdmin(
            "🚛 New Contact Form submission",
            `<pre>
        📩 A visitor submitted a question!

        📧 Email: ${email}
        📞 Phone: ${phone}
        📝 Message: ${message}

        🕒 Submitted At: ${new Date().toLocaleString()} 
        </pre>`
        );
    } catch (emailError) {
        console.error("❌ Email Error:", emailError);
    }
}

async function getAllSignUpForms(req, res) {
    try {
        const result = await prisma.signUpForm.findMany({
            take: 50,
            skip: 0,
        });
        console.log(`SignUpForms Retrieved: ${result.length} records`);
        res.status(200).json(result);
    } catch (error) {
        console.error("Database Error (getAllSignUpForms):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
}

async function getAllContactForms(req, res) {
    try {
        const result = await prisma.contactForm.findMany({
            take: 50,
            skip: 0,
        });
        console.log(`ContactForms Retrieved: ${result.length} records`);
        res.status(200).json(result);
    } catch (error) {
        console.error("Database Error (getAllContactForms):", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
}

export {
    logRequestBody,
    validateSignUpForm,
    validateContactForm,
    sanitizeSignUpForm,
    sanitizeContactForm,
    signUpForm,
    contactForm,
    getAllSignUpForms,
    getAllContactForms,
};
