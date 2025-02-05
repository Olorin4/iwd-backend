const { Pool } = require("pg");
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const dotenv = require("dotenv");
const nodemailer = require("nodemailer");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// PostgreSQL Database Configuration
const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASS,
    port: process.env.DB_PORT,
});

// Middleware
const allowedOrigins = [
    "https://iron-wing-dispatching.com",
    "https://console.hetzner.cloud", // Add Hetzner Console if needed
    "http://localhost:3000", // Allow local testing
    "http://localhost:5173", // If using Vite/React
];

app.use(bodyParser.json());

// Create Table If Not Exists
pool.query(
    `CREATE TABLE IF NOT EXISTS submissions (
        id SERIAL PRIMARY KEY,
        firstName TEXT NOT NULL,
        lastName TEXT NOT NULL,
        email TEXT NOT NULL,
        tel TEXT NOT NULL,
        fleetSize TEXT NOT NULL,
        trailerType TEXT NOT NULL,
        submittedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`
);

// Email Transporter Configuration
const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST, // smtp.zoho.eu
    port: process.env.EMAIL_PORT, // 465
    secure: false, // Use STARTTLS, NOT SSL
    auth: {
        user: process.env.EMAIL_USER, // Your Zoho email
        pass: process.env.EMAIL_PASS, // Zoho App Password
    },
    tls: {
        ciphers: "SSLv3",
        rejectUnauthorized: false, // Sometimes needed for Zoho
    },
});

// Handle Form Submissions
app.post("/submit-form", async (req, res) => {
    const { firstName, lastName, email, tel, fleetSize, trailerType } = req.body;

    if (!firstName || !lastName || !email || !tel || !fleetSize || !trailerType) {
        return res.status(400).json({ error: "All required fields must be filled." });
    }

    console.log("Form received:", req.body);

    try {
        // Insert into PostgreSQL
        const result = await pool.query(
            "INSERT INTO submissions (firstName, lastName, email, tel, fleetSize, trailerType) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
            [firstName, lastName, email, tel, fleetSize, trailerType]
        );
        console.log("✅ Data inserted successfully. Submission ID:", result.rows[0].id);

        // **1️⃣ Auto-Reply Email to the Potential Client**
        const clientMailOptions = {
            from: process.env.EMAIL_FROM, // Example: info@iron-wing-dispatching.com
            to: email,
            subject: "Thank You for Signing Up!",
            text: `Hello ${firstName},\n\nThank you for signing up with Iron Wing Dispatching. We will contact you shortly.\n\nBest,\nIron Wing Dispatching Team`,
        };

        try {
            await transporter.sendMail(clientMailOptions);
            console.log("📧 Email Auto-Reply Sent to Client Successfully!");
        } catch (emailError) {
            console.error("❌ Error sending email auto-reply:", emailError);
        }

        // **2️⃣ Email to Your Zoho Address with Full Submission Details**
        const zohoMailOptions = {
            from: process.env.EMAIL_FROM,
            to: process.env.EMAIL_USER,
            subject: "🚛 New Form Submission Received",
            text: `
                📩 A new form submission has been received!

                👤 Name: ${firstName} ${lastName}
                📧 Email: ${email}
                📞 Phone: ${tel}
                🚛 Fleet Size: ${fleetSize}
                🛻 Trailer Type: ${trailerType}

                🕒 Submitted At: ${new Date().toLocaleString()}
            `,
        };

        try {
            await transporter.sendMail(zohoMailOptions);
            console.log("📧 Form Data Sent to Zoho Mail Successfully!");
        } catch (zohoEmailError) {
            console.error("❌ Error sending form data email to Zoho:", zohoEmailError);
        }

        res.status(200).json({ message: "Form submitted successfully!", id: result.rows[0].id });
    } catch (error) {
        console.error("Database error:", error);
        res.status(500).json({ error: "Database error" });
    }
});

app.get("/submissions", async (req, res) => {
    try {
        // Fetch all submissions from the database
        const result = await pool.query("SELECT * FROM submissions ORDER BY submittedAt DESC");

        // Log the data for debugging
        console.log("📂 Retrieved Submissions:", result.rows);

        res.status(200).json(result.rows);
    } catch (error) {
        console.error("❌ Database error while fetching submissions:", error);
        res.status(500).json({ error: "Database error while retrieving submissions." });
    }
});

// Start Server
app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running at http://0.0.0.0:${PORT}`);
});
