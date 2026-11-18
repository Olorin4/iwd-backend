import { PORTAL_BASE_URL } from "../config.js";

export function isPortalPath(path) {
    return /^\/p(?:\/|$|[?#])/i.test(path ?? "");
}

const assetPath = (path) => /^\/portal-static\//i.test(path);

export function hostGuard(baseUrl = PORTAL_BASE_URL) {
    let host = new URL(PORTAL_BASE_URL).host;
    try {
        if (baseUrl) host = new URL(baseUrl).host;
    } catch {
        // An invalid configuration must still isolate the production host.
    }
    return (req, res, next) => {
        const requestHost = req.get("host")?.toLowerCase().replace(/:443$/, "");
        const portal =
            requestHost === host ||
            requestHost === new URL(PORTAL_BASE_URL).host;
        const path = isPortalPath(req.path) || assetPath(req.path);
        if (portal !== path) return res.status(404).end();
        res.locals.onPortalHost = portal;
        next();
    };
}
