// src/controllers/handler.js

import { PrismaClient } from "@prisma/client";
import dotenv from "dotenv-flow";
import {
    sendClientReply,
    sendAdminNotification,
} from "../services/emailService.js";

dotenv.config();

// Connect to the Database
const prisma = new PrismaClient();

// Handle Form Submissions
export const submitForm = async (req, res) => {
    console.log("📩 Received Form Data:", req.body);

    const { firstName, lastName, email, phone, fleetSize, trailerType, plan } =
        req.body;

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
            data: req.body,
        });
        console.log("✅ Inserted Sign-Up Form ID:", result.id);

        res.status(200).json({
            message: "Form submitted successfully!",
            id: result.id,
        });
    } catch (error) {
        if (error.code === "P2002" && error.meta.target.includes("email")) {
            console.warn("⚠️ Duplicate Email Error:", email);
            return res.status(409).json({ error: "Email already registered." });
        }
        console.error("❌ Prisma Error:", error);
        res.status(500).json({ error: error.message });
    }

    await sendClientReply(
        email,
        "Thank You for Signing Up!",
        `Hello ${firstName},\n\nThank you for signing up with Iron Wing Dispatching. We will contact you shortly.\n\nAll the best,\nIron Wing Dispatching Team`
    );

    await sendAdminNotification(
        "🚛 New Sign-Up Form Received",
        `
        📩 A new sign-up form has been received!

        👤 Name: ${firstName} ${lastName}
        📧 Email: ${email}
        📞 Phone: ${phone}
        🚛 Fleet Size: ${fleetSize}
        🛻 Trailer Type: ${trailerType}
        📌 Plan Selected: ${plan} 

        🕒 Submitted At: ${new Date().toLocaleString()}`
    );
};

// Handle Contact Form Submissions
export const contactForm = async (req, res) => {
    const { email, phone, message } = req.body;

    if (!email || !message) {
        return res
            .status(400)
            .json({ error: "Email and message are required." });
    }
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

    await sendClientReply(
        email,
        "Thank You for contacting us!",
        `Hello,\n\nThank you for contacting Iron Wing Dispatching. We will reach out soon.\n\nAll the best,\nIron Wing Dispatching Team`
    );

    await sendAdminNotification(
        "🚛 New Contact Form submission",
        `
        📩 A visitor submitted a question!

        📧 Email: ${email}
        📞 Phone: ${phone}
        📝 Message: ${message}

        🕒 Submitted At: ${new Date().toLocaleString()} `
    );
};
