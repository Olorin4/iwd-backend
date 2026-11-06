// Server-side Cloudflare Turnstile enforcement for the public form endpoints.
//
// The site sends the widget's token as `turnstileToken` in the JSON body. We
// verify it with Cloudflare's siteverify endpoint (using the widget secret and
// the visitor's IP) and refuse the request unless Cloudflare says it is valid.
// Without this check, a bot can skip the web page and POST straight to the API.
//
// Fails closed: if the secret is not configured, or Cloudflare cannot be
// reached, the request is rejected rather than let through.

const SITEVERIFY_URL =
    "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;
// Cloudflare documents a 2048-character maximum for tokens.
const MAX_TOKEN_LENGTH = 2048;

// Resolves to "valid", "invalid" or "unavailable".
async function checkToken(secret, token, remoteip) {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteip) body.set("remoteip", remoteip);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
        const response = await fetch(SITEVERIFY_URL, {
            method: "POST",
            body,
            signal: controller.signal,
        });
        if (!response.ok) {
            console.error(`Turnstile siteverify returned ${response.status}`);
            return "unavailable";
        }
        const data = await response.json();
        if (data.success === true) return "valid";
        console.warn("Turnstile token rejected:", data["error-codes"]);
        return "invalid";
    } catch (error) {
        console.error("Turnstile siteverify unreachable:", error.message);
        return "unavailable";
    } finally {
        clearTimeout(timer);
    }
}

async function requireTurnstile(req, res, next) {
    const token = req.body?.turnstileToken;
    // Remove the token so it never reaches the validators, logs or database.
    if (req.body) delete req.body.turnstileToken;

    const secret = process.env.TURNSTILE_SECRET_KEY;
    if (!secret) {
        console.error("TURNSTILE_SECRET_KEY is not set; rejecting request.");
        return res
            .status(503)
            .json({ error: "Bot protection is not configured." });
    }

    if (
        typeof token !== "string" ||
        !token ||
        token.length > MAX_TOKEN_LENGTH
    ) {
        return res.status(403).json({ error: "Security check failed." });
    }

    const result = await checkToken(secret, token, req.ip);
    if (result === "valid") return next();
    if (result === "invalid") {
        return res.status(403).json({ error: "Security check failed." });
    }
    return res
        .status(503)
        .json({ error: "Security check unavailable. Please try again." });
}

export { requireTurnstile, SITEVERIFY_URL };
