// src/controllers/formsController.js

import dotenv from "dotenv-flow";
import { prisma } from "../config/prismaClient.js";
import { emailClient, emailAdmin } from "../services/emailService.js";

dotenv.config();

// Handle Form Submissions
export async function submitForm(req, res) {
    console.log("📩 Received Form Data:", req.body);

    // Mapping camelCase to snake_case for Prisma
    const {
        firstName: first_name,
        lastName: last_name,
        email,
        phone,
        fleetSize: fleet_size,
        trailerType: trailer_type,
        plan,
    } = req.body;

    // Validate required fields
    if (
        !first_name ||
        !last_name ||
        !email ||
        !phone ||
        !fleet_size ||
        !trailer_type ||
        !plan
    ) {
        console.warn("⚠️ Missing required fields:", req.body);
        return res.status(400).json({ error: "All fields are required." });
    }

    try {
        const result = await prisma.signUpForm.create({
            data: {
                first_name,
                last_name,
                email,
                phone,
                fleet_size,
                trailer_type,
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
        res.status(500).json({ error: error.message });
    }

    await emailClient(
        email,
        "Thank You for Signing Up!",
        `Hello ${first_name},\n\nThank you for signing up with Iron Wing Dispatching. We will contact you shortly.\n\nAll the best,\nIron Wing Dispatching Team`
    );

    await emailAdmin(
        "🚛 New Sign-Up Form Received",
        `<pre>
        📩 A new sign-up form has been received!

        👤 Name: ${first_name} ${last_name}
        📧 Email: ${email}
        📞 Phone: ${phone}
        🚛 Fleet Size: ${fleet_size}
        🛻 Trailer Type: ${trailer_type}
        📌 Plan Selected: ${plan} 

        🕒 Submitted At: ${new Date().toLocaleString()}
        </pre>`
    );
}

// Handle Contact Form Submissions
export async function contactForm(req, res) {
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
}

export async function getAllSignUpForms(limit = 50, offset = 0) {
    try {
        const result = await prisma.signUpForm.findMany({
            take: limit,
            skip: offset,
        });
        console.log(`SignUpForms Retrieved: ${result.length} records`);
        return result;
    } catch (error) {
        console.error("Database Error (getAllSignUpForms):", error);
        throw error;
    }
}

export async function getAllContactForms(limit = 50, offset = 0) {
    try {
        const result = await prisma.contactForm.findMany({
            take: limit,
            skip: offset,
        });
        console.log(`ContactForms Retrieved: ${result.length} records`);
        return result;
    } catch (error) {
        console.error("Database Error (getAllContactForms):", error);
        throw error;
    }
}
