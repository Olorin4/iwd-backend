import { bearerMatches, verifyRequestV2 } from "./signing.js";

const header = (req, name) => {
    const value = req.headers[name];
    return typeof value === "string" && value.length > 0 ? value : null;
};

/**
 * Service authentication for Outreach → iwd-backend calls: bearer
 * IWD_ONBOARDING_TOKEN AND an X-IW-Signature v2 over method, request target
 * (`req.originalUrl`), actor headers, raw body and the X-IW-Nonce header. v1 is refused on this link.
 *
 * - A body `actor` (PUT, actions) must equal the signed actor headers.
 * - `replayStore(key)` returns false when the signature was already used; it
 *   applies to every method, GET included (401 `replayed_signature`).
 * - The verified actor (or null for system calls) is put on
 *   `res.locals.signedActor`.
 */
export function requireService(
    getConfig,
    { now = () => Date.now(), replayStore } = {}
) {
    return async (req, res, next) => {
        const config = getConfig();
        if (!bearerMatches(req.headers.authorization, config.serviceToken))
            return res.status(401).json({ error: "unauthorized" });
        const actorId = header(req, "x-iw-actor-id");
        const actorEmail = header(req, "x-iw-actor-email");
        if (
            (actorId && actorId.length > 100) ||
            (actorEmail && actorEmail.length > 254)
        )
            return res.status(401).json({ error: "actor_header_invalid" });
        const verified = verifyRequestV2({
            secret: config.requestSigningSecret,
            header: req.headers["x-iw-signature"],
            method: req.method,
            pathAndQuery: req.originalUrl,
            actorId,
            actorEmail,
            rawBody: req.rawBody ?? Buffer.alloc(0),
            nonce: req.headers["x-iw-nonce"],
            nowSeconds: Math.floor(now() / 1000),
        });
        if (verified.error)
            return res.status(401).json({ error: verified.error });
        const bodyActor =
            req.body && typeof req.body === "object" && !Array.isArray(req.body)
                ? req.body.actor
                : undefined;
        if (bodyActor !== undefined) {
            const matches =
                bodyActor &&
                typeof bodyActor === "object" &&
                actorId !== null &&
                actorEmail !== null &&
                bodyActor.user_id === actorId &&
                typeof bodyActor.email === "string" &&
                bodyActor.email.toLowerCase() === actorEmail.toLowerCase();
            if (!matches)
                return res.status(401).json({ error: "actor_mismatch" });
        }
        if (replayStore && !(await replayStore(`v2:${verified.v2}`)))
            return res.status(401).json({ error: "replayed_signature" });
        res.locals.signedActor =
            actorId || actorEmail
                ? { user_id: actorId, email: actorEmail?.toLowerCase() ?? null }
                : null;
        return next();
    };
}
