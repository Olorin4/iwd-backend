import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import router from "./router.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middleware
app.use(helmet());
app.use(
    helmet.contentSecurityPolicy({
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    })
);

// CORS Configuration
const whitelist = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://iron-wing-dispatching.com",
    "https://api.iron-wing-dispatching.com",
];

const corsOptions = {
    origin(origin, callback) {
        if (whitelist.indexOf(origin) !== -1 || !origin) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    },
    credentials: true,
};

app.use(cors(corsOptions));

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});

// Global Middleware
app.use(express.json());
app.use(limiter);
app.set("trust proxy", "loopback");
app.get("/", (req, res) => res.send("Iron Wing API is working!"));

app.use(router); // Register all routes AFTER applying middleware

// Fallback Route for Not Found
app.use((req, res) => res.status(404).json({ error: "Not Found" }));
// Error Handling Middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: "Internal Server Error" });
});

// Start Server
app.listen(PORT, "0.0.0.0", () =>
    console.log(`Iron Wing Server running at http://0.0.0.0:${PORT}`)
);
