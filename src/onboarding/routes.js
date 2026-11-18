import express from "express";
import { requireService } from "./auth.js";
import { OnboardingError, getRequestStatus, putRequest } from "./requests.js";
import { handleSignwellWebhook } from "./signatureFlow.js";
import { handleContinue, handleStripeWebhook } from "./paymentFlow.js";
import { verifyContinueToken } from "./continueToken.js";
import {
    ironWingSigningUrl,
    readSignedDocument,
    runAction,
} from "./actions.js";

/** Captures the raw JSON body for HMAC and webhook signature checks. */
export function onboardingRawBody(req, res, buf) {
    req.rawBody = buf;
}

const KEY = /^[0-9a-fA-F-]{36}$/;

export const PAYMENT_SAVED_TEXT =
    "Your payment method is saved. Nothing has been charged. We've emailed you your signed agreement and a short list of documents we need. You can close this page.";

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
    // Signature v2 on every Outreach call; every accepted signature is
    // recorded, so a replay inside the window is refused on any method.
    const service = (req, res, next) => {
        const d = depsOf(res);
        return requireService(() => res.locals.onboardingConfig, {
            now: () => d.now().getTime(),
            replayStore: (key) => d.recordReceipt("outreach", key),
        })(req, res, next);
    };
    router.param("key", (req, res, next, key) =>
        KEY.test(key) ? next() : res.status(404).json({ error: "not_found" })
    );

    router.put(
        "/requests/:key",
        service,
        wrap(async (req, res, d) => {
            const result = await putRequest(d, req.params.key, req.body);
            if (result.created)
                d.schedule(() => d.onRequestCreated(result.row));
            res.status(result.status).json(result.body);
        })
    );

    router.get(
        "/requests/:key",
        service,
        wrap(async (req, res, d) =>
            res.json(await getRequestStatus(d, req.params.key))
        )
    );

    router.post(
        "/requests/:key/actions/:action",
        service,
        wrap(async (req, res, d) =>
            res.json(
                await runAction(d, req.params.key, req.params.action, req.body)
            )
        )
    );

    // Never public: service auth plus an actor, and every read is logged.
    router.get(
        "/requests/:key/documents/signed",
        service,
        wrap(async (req, res, d) => {
            // The actor comes from the signed headers (signature v2).
            const document = await readSignedDocument(
                d,
                req.params.key,
                res.locals.signedActor ?? {}
            );
            res.set("Cache-Control", "no-store");
            res.set("X-Content-SHA256", document.sha256);
            res.set(
                "Content-Disposition",
                `attachment; filename="${document.filename}"`
            );
            res.type("application/pdf").send(document.bytes);
        })
    );

    // R14: the owner signs as Iron Wing in Outreach. Service auth plus a
    // required actor; every disclosure is logged; the URL is never logged.
    router.get(
        "/requests/:key/iron-wing-signing-url",
        service,
        wrap(async (req, res, d) => {
            res.set("Cache-Control", "no-store");
            res.set("Referrer-Policy", "no-referrer");
            res.json(
                await ironWingSigningUrl(
                    d,
                    req.params.key,
                    res.locals.signedActor ?? {}
                )
            );
        })
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

    // R15: Stripe Checkout's success page (ONBOARDING_STRIPE_SUCCESS_URL).
    // Public and static: reads no request data and reveals nothing.
    router.get("/payment-saved", (req, res) => {
        res.set("Cache-Control", "no-store");
        res.set("Referrer-Policy", "no-referrer");
        res.status(200).type("text/plain").send(PAYMENT_SAVED_TEXT);
    });

    // eslint-disable-next-line no-unused-vars -- Express needs four arguments here.
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
