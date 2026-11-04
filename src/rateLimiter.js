import rateLimit from "express-rate-limit";

// Factory so tests can use small limits.
function createLimiter({ windowMs, max, skip } = {}) {
    return rateLimit({
        windowMs: windowMs ?? 15 * 60 * 1000,
        max: max ?? 100,
        skip,
        standardHeaders: true,
        legacyHeaders: false,
    });
}

// Applied to every request. Health checks are exempt so monitoring cannot use
// up visitors' budget.
const limiter = createLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // per client IP per window
    skip: (req) => req.path === "/health-check",
});

// Stricter limit for the public newsletter endpoint, which triggers an email.
const newsletterLimiter = createLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // signups per client IP per hour
});

export { createLimiter, limiter, newsletterLimiter };
