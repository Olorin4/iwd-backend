import { bearerMatches, verifySignature } from "./signing.js";

/**
 * Service authentication for Outreach → iwd-backend calls (design §5):
 * bearer IWD_ONBOARDING_TOKEN AND X-IW-Signature over the raw body.
 * `replayStore(signature)` (optional) returns false when the exact signature
 * was already used; it guards state-changing actions against replays inside
 * the 300 s window. PUT relies on its idempotency key instead.
 */
export function requireService(
    getConfig,
    { now = () => Date.now(), replayStore } = {}
) {
    return async (req, res, next) => {
        const config = getConfig();
        if (!bearerMatches(req.headers.authorization, config.serviceToken))
            return res.status(401).json({ error: "unauthorized" });
        const header = req.headers["x-iw-signature"];
        const reason = verifySignature({
            secret: config.requestSigningSecret,
            header,
            rawBody: req.rawBody ?? Buffer.alloc(0),
            nowSeconds: Math.floor(now() / 1000),
        });
        if (reason) return res.status(401).json({ error: reason });
        if (replayStore && !(await replayStore(header)))
            return res.status(409).json({ error: "replayed_request" });
        return next();
    };
}
