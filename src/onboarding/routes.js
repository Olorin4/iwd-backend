import express from "express";
import { requireService } from "./auth.js";
import { OnboardingError, getRequestStatus, putRequest } from "./requests.js";
import { handleSignwellWebhook } from "./signatureFlow.js";
import { handleContinue, handleStripeWebhook } from "./paymentFlow.js";
import { verifyContinueToken } from "./continueToken.js";

/** Captures the raw JSON body for HMAC and webhook signature checks. */
export function onboardingRawBody(req, res, buf) {
    req.rawBody = buf;
}

const KEY = /^[0-9a-fA-F-]{36}$/;

export function createOnboardingRouter(getConfig, getDeps) {
    const router = express.Router();

    router.use((req, res, next) => {
        let config;
        try {
            config = getConfig();
        } catch {
            return res.status(503).json({ error: "onboarding_config_invalid" });
        }
        if (!config.enabled)
            return res.status(404).json({ error: "not_found" });
        res.locals.onboardingConfig = config;
        res.locals.onboardingDeps = getDeps(config);
        return next();
    });

    const depsOf = (res) => res.locals.onboardingDeps;
    const wrap = (fn) => (req, res, next) =>
        Promise.resolve(fn(req, res, depsOf(res))).catch(next);
    const auth = (options) => (req, res, next) => {
        const d = depsOf(res);
        return requireService(() => res.locals.onboardingConfig, {
            now: () => d.now().getTime(),
            ...(options.replay
                ? {
                      replayStore: (signature) =>
                          d.recordReceipt("outreach", signature),
                  }
                : {}),
        })(req, res, next);
    };
    const service = auth({ replay: true });
    const serviceNoReplay = auth({ replay: false });
    router.param("key", (req, res, next, key) =>
        KEY.test(key) ? next() : res.status(404).json({ error: "not_found" })
    );

    router.put(
        "/requests/:key",
        serviceNoReplay,
        wrap(async (req, res, d) => {
            const result = await putRequest(d, req.params.key, req.body);
            if (result.created)
                d.schedule(() => d.onRequestCreated(result.row));
            res.status(result.status).json(result.body);
        })
    );

    router.get(
        "/requests/:key",
        serviceNoReplay,
        wrap(async (req, res, d) =>
            res.json(await getRequestStatus(d, req.params.key))
        )
    );

    // Provider webhooks: authenticated by the provider's own scheme, then
    // treated as hints (the owning record is re-fetched).
    router.post(
        "/webhooks/signwell",
        wrap(async (req, res, d) => {
            const status = await handleSignwellWebhook(d, req.body);
            res.status(status).json(
                status === 200 ? { received: true } : { error: "invalid_event" }
            );
        })
    );

    router.post(
        "/webhooks/stripe",
        wrap(async (req, res, d) => {
            const status = await handleStripeWebhook(
                d,
                req.rawBody,
                req.headers["stripe-signature"]
            );
            res.status(status).json(
                status === 200 ? { received: true } : { error: "invalid_event" }
            );
        })
    );

    // Public, signed and expiring link; plain text pages, no internal detail.
    router.get(
        "/continue/:token",
        wrap(async (req, res, d) => {
            const result = await handleContinue(d, req.params.token, (token) =>
                verifyContinueToken(
                    d.config.continueSecret,
                    token,
                    Math.floor(d.now().getTime() / 1000)
                )
            );
            res.set("Cache-Control", "no-store");
            res.set("Referrer-Policy", "no-referrer");
            if (result.location) return res.redirect(303, result.location);
            return res
                .status(result.status)
                .type("text/plain")
                .send(result.text);
        })
    );

    router.use((error, req, res, next) => {
        if (error instanceof OnboardingError)
            return res
                .status(error.status)
                .json({ error: error.code, ...error.extra });
        if (error?.type === "entity.parse.failed")
            return res.status(400).json({ error: "invalid_json" });
        try {
            depsOf(res)?.logger?.error({
                code: "onboarding_route_failed",
                route: req.route?.path,
            });
        } catch {
            // logging must never mask the response
        }
        return res.status(500).json({ error: "internal_error" });
    });
    return router;
}
