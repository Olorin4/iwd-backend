// src/services/emailService.js

import nodemailer from "nodemailer";
import dotenv from "dotenv-flow";

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
export const sendEmail = async (mailOptions) => {
    try {
        const info = await transporter.sendMail(mailOptions);
        console.log("📧 Email Sent Successfully:", info.messageId);
        return info;
    } catch (error) {
        console.error("❌ Error Sending Email:", error);
        throw error;
    }
};

// Send Client Auto-Reply Email
export const sendClientReply = async (to, subject, text) => {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        replyTo: to,
        to: to,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
};

// Send Admin Notification Email
export const sendAdminNotification = async (subject, text) => {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
};
