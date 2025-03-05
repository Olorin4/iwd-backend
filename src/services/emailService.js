// src/services/emailService.js

import nodemailer from "nodemailer";
import dotenv from "dotenv-flow";
import signature from "../assets/signature.js";

dotenv.config();

const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: process.env.EMAIL_PORT,
    secure: false,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        ciphers: "SSLv3",
        rejectUnauthorized: false,
    },
});

// Reusable Function to Send Emails
export async function sendEmail(mailOptions) {
    // Always send emails in HTML format with the signature
    mailOptions.html = `
        <p>${mailOptions.text}</p>
        ${signature}
    `;
    delete mailOptions.text;

    mailOptions.attachments = [
        {
            filename: "linkedin_32.png",
            path: "src/assets/linkedin_32.png",
            cid: "linkedinIcon",
        },
        {
            filename: "logo.jpg",
            path: "src/assets/logo.jpg",
            cid: "companyLogo",
        },
    ];

    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("📧 Email Sent Successfully:", info.messageId);
        return info;
    } catch (error) {
        console.error("❌ Error Sending Email:", error);
        throw error;
    }
}

// Send Client Auto-Reply Email
export async function emailClient(to, subject, text) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        replyTo: to,
        to: to,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
}

// Send Admin Notification Email
export async function emailAdmin(subject, text) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
}
