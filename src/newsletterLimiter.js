import rateLimit from "express-rate-limit";

// Stricter limit for the public newsletter endpoint, which triggers an email.
const newsletterLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 signups per IP per hour
    standardHeaders: true,
    legacyHeaders: false,
});

export { newsletterLimiter };
