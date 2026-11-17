// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { createHash, timingSafeEqual } from "node:crypto";
const digest = (value) => createHash("sha256").update(value).digest();
export function requireInterimAdmin(getConfig) {
    return (req, res, next) => {
        let config;
        try {
            config = getConfig();
        } catch {
            return res.status(401).json({ error: "unauthorized" });
        }
        if (!config.enabled)
            return res.status(404).json({ error: "not_found" });
        const supplied =
            /^Bearer ([^\s]+)$/.exec(req.headers.authorization ?? "")?.[1] ??
            "";
        if (
            typeof config.adminToken !== "string" ||
            config.adminToken.length < 32 ||
            supplied.length < 32 ||
            !timingSafeEqual(digest(supplied), digest(config.adminToken))
        )
            return res.status(401).json({ error: "unauthorized" });
        next();
    };
}
