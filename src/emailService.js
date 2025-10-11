import nodemailer from "nodemailer";
import dotenv from "dotenv";
import signature from "./assets/signature.js";

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

// Avoid logging sensitive email credentials
console.log = function () {};

// Validate email inputs before sending
function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

// Reusable Function to Send Emails
async function sendEmail(mailOptions) {
    if (!validateEmail(mailOptions.to)) {
        throw new Error("Invalid recipient email address.");
    }

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
        return info;
    } catch (error) {
        throw error;
    }
}

async function emailClient(to, subject, text) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        replyTo: to,
        to: to,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
}

async function emailAdmin(subject, text) {
    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        subject: subject,
        text: text,
    };
    return sendEmail(mailOptions);
}

export { sendEmail, emailClient, emailAdmin };
