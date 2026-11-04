import helmet from "helmet";
import cors from "cors";
import { limiter } from "./rateLimiter.js";
import crypto from "crypto";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function configureSecurity(app) {
    // Helmet for setting security-related HTTP headers:
    app.use(helmet());
    app.use(
        helmet.contentSecurityPolicy({
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: [
                    "'self'",
                    (req, res) => `'nonce-${res.locals.cspNonce}'`,
                ],
                styleSrc: [
                    "'self'",
                    (req, res) => `'nonce-${res.locals.cspNonce}'`,
                ],
                imgSrc: ["'self'", "data:"],
                connectSrc: ["'self'"],
                fontSrc: ["'self'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'self'"],
                frameSrc: ["'none'"],
            },
        })
    );

    // Middleware to generate CSP nonce
    app.use((req, res, next) => {
        res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
        next();
    });

    // CORS Configuration
    const whitelist = [
        "http://localhost:3000",
        "http://localhost:3001",
        "https://iron-wing-dispatching.com",
        "https://api.iron-wing-dispatching.com",
    ];

    const corsOptions = {
        origin(origin, callback) {
            if (whitelist.indexOf(origin) !== -1 || !origin)
                callback(null, true);
            else callback(new Error("Not allowed by CORS"));
        },
        credentials: true,
    };

    // Apply CORS (also handles preflight OPTIONS requests)
    app.use(cors(corsOptions));

    app.use(limiter);

    // Morgan for logging security-related events:
    const accessLogStream = fs.createWriteStream(
        path.join(__dirname, "../logs/access.log"),
        { flags: "a" }
    );

    app.use(
        morgan("combined", {
            stream: accessLogStream,
            skip: (req, res) => res.statusCode < 400, // Log only errors and warnings
        })
    );
}

export { configureSecurity };
