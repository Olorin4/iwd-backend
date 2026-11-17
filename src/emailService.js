import nodemailer from "nodemailer";
import dotenv from "dotenv";
import signature, { textSignature } from "./assets/signature.js";

dotenv.config();

const port = Number(process.env.EMAIL_PORT) || 587;

// Port 465 is encrypted from the start; any other port must upgrade with
// STARTTLS before the password is sent. Nodemailer checks the server's
// certificate by default, which is what keeps the login private.
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

function validateEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return typeof email === "string" && emailRegex.test(email);
}

const HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// Plain text to HTML: everything escaped, blank lines start a paragraph and
// single line breaks are kept.
function textToHtml(text) {
    return String(text)
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .filter(Boolean)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
        .join("\n");
}

// Sends `text` as a plain-text part and as HTML with the signature.
async function sendEmail({ text, ...mailOptions }) {
    if (!validateEmail(mailOptions.to)) {
        throw new Error("Invalid recipient email address.");
    }

    return transporter.sendMail({
        ...mailOptions,
        text: `${text}\n\n${textSignature}`,
        html: `${textToHtml(text)}\n${signature}`,
        attachments: [
            {
                filename: "logo.jpg",
                path: "src/assets/logo.jpg",
                cid: "companyLogo",
            },
        ],
    });
}

// An email to a carrier or visitor. Replies go to the business mailbox (the
// From address).
async function emailClient(to, subject, text) {
    return sendEmail({
        from: process.env.EMAIL_USER,
        to,
        subject,
        text,
    });
}

// An alert to the business mailbox. `replyTo` lets the owner answer the
// person who submitted the form directly.
async function emailAdmin(subject, text, { replyTo } = {}) {
    return sendEmail({
        from: process.env.EMAIL_USER,
        to: process.env.EMAIL_USER,
        ...(validateEmail(replyTo) ? { replyTo } : {}),
        subject,
        text,
    });
}

export { sendEmail, emailClient, emailAdmin, escapeHtml, textToHtml };
