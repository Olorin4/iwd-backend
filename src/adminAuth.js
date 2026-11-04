import crypto from "crypto";

// Hash both values so timingSafeEqual always compares equal-length buffers
// and the comparison time does not depend on where the strings differ.
const digest = (value) =>
    crypto.createHash("sha256").update(String(value)).digest();

let warnedMissingToken = false;

/**
 * Protects admin-only routes (lead listings) with a shared bearer token.
 * Fails closed: if ADMIN_API_TOKEN is not configured, every request is denied.
 */
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_API_TOKEN;

    if (!expected) {
        if (!warnedMissingToken) {
            warnedMissingToken = true;
            console.error(
                "ADMIN_API_TOKEN is not set; admin routes are disabled."
            );
        }
        return res.status(401).json({ error: "Unauthorized" });
    }

    const [scheme, token] = (req.get("authorization") || "").split(" ");
    const valid =
        scheme?.toLowerCase() === "bearer" &&
        Boolean(token) &&
        crypto.timingSafeEqual(digest(token), digest(expected));

    if (!valid) {
        res.set("WWW-Authenticate", "Bearer");
        return res.status(401).json({ error: "Unauthorized" });
    }

    next();
}

export { requireAdmin };
