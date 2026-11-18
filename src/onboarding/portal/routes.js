import express from "express";
import Busboy from "busboy";
import path from "node:path";
import { readSignedDocumentForRequest } from "../actions.js";
import { PORTAL_BASE_URL } from "../config.js";
import {
    markNotFactoring,
    readDocumentFile,
    recordUpload,
    UPLOADABLE_KEYS,
} from "../files/documents.js";
import { handleContinue } from "../paymentFlow.js";
import { saveQuestionnaire } from "../questionnaire.js";
import { carrierSigningUrl } from "../signatureFlow.js";
import { transition } from "../store.js";
import { csrfToken, validCsrf } from "./csrf.js";
import { hostGuard } from "./hostGuard.js";
import { resolvePortalToken } from "./tokens.js";
import {
    inactivePage,
    messagePage,
    portalPage,
    questionnairePage,
} from "./views.js";

const FILES = path.resolve("src/onboarding/portal/static");
const OPEN_THROTTLE = 5 * 60 * 1000;
const CSP =
    "default-src 'self'; img-src 'self' data:; form-action 'self' https://checkout.stripe.com; frame-ancestors 'none'; base-uri 'none'";

async function multipart(req, maxBytes) {
    return new Promise((resolve, reject) => {
        let stream;
        try {
            stream = Busboy({
                headers: req.headers,
                limits: {
                    fileSize: maxBytes + 1,
                    files: 1,
                    fields: 1,
                    fieldSize: 128,
                    parts: 3,
                },
            });
        } catch {
            req.resume();
            return resolve({ error: "unsupported_type" });
        }
        const chunks = [];
        let csrf;
        let error;
        stream.on("field", (name, value, info) => {
            if (name === "csrf" && !info.valueTruncated) csrf = value;
            else error = "unsupported_type";
        });
        stream.on("file", (name, file) => {
            if (name !== "file") error = "unsupported_type";
            file.on("data", (chunk) => chunks.push(chunk));
            file.on("limit", () => {
                error = "too_large";
            });
            file.on("error", reject);
        });
        for (const event of ["fieldsLimit", "filesLimit", "partsLimit"])
            stream.on(event, () => {
                error ??= "unsupported_type";
            });
        stream.once("error", () =>
            resolve({ csrf, error: "unsupported_type" })
        );
        stream.once("close", () =>
            resolve({ csrf, error, bytes: Buffer.concat(chunks) })
        );
        req.once("aborted", () => stream.destroy());
        req.pipe(stream);
    });
}

const asyncRoute = (handler) => (req, res, next) =>
    Promise.resolve(handler(req, res, next)).catch(next);
const unavailable = (res) =>
    res
        .status(503)
        .send(
            messagePage(
                "Temporarily unavailable",
                "Please try again in a moment."
            )
        );
const closed = (res) =>
    res
        .status(409)
        .send(
            messagePage(
                "Step unavailable",
                "Complete your agreement first or contact Iron Wing for help."
            )
        );
const denied = (res) =>
    res
        .status(403)
        .send(
            messagePage(
                "Unable to submit",
                "Open your onboarding page and try again."
            )
        );

export function createPortalRouter(
    getConfig,
    getDeps,
    { baseUrl = PORTAL_BASE_URL, rateLimit } = {}
) {
    const router = express.Router();
    router.use(hostGuard(baseUrl));
    router.use(
        "/portal-static",
        express.static(FILES, {
            immutable: true,
            maxAge: "1y",
            index: false,
            redirect: false,
        })
    );
    router.use("/p", (req, res, next) => {
        res.set({
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Robots-Tag": "noindex",
            "Content-Security-Policy": CSP,
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
        });
        next();
    });

    if (rateLimit) router.use("/p", rateLimit);

    const page = express.Router();
    router.use(
        "/p/:token",
        asyncRoute(async (req, res, next) => {
            const config = getConfig();
            if (!config.portal?.enabled)
                return res.status(410).send(inactivePage());
            const deps = getDeps(config);
            const result = await resolvePortalToken(deps, req.params.token);
            if (result.error) return res.status(410).send(inactivePage());
            res.locals.portal = {
                deps,
                ...result,
                path: "/p/" + req.params.token,
                csrf: csrfToken(config.portal.tokenSecret, result.tokenId),
            };
            if (
                req.method === "POST" &&
                req.get("Origin") !== config.portal.baseUrl
            )
                return denied(res);
            next();
        }),
        page
    );

    const render = async (req, res, { signed, returned } = {}) => {
        const { deps, row, path, csrf } = res.locals.portal;
        const [ownFiles, questionnaire] = await Promise.all([
            deps.db.onboardingDocument.findMany({
                where: {
                    request_id: row.id,
                    source: "CARRIER",
                    state: "CURRENT",
                    purged_at: null,
                    storage_key: { not: null },
                },
                select: { id: true, item_key: true },
            }),
            deps.db.onboardingQuestionnaire.findUnique({
                where: { request_id: row.id },
                select: { request_id: true },
            }),
        ]);
        return res.send(
            portalPage(row, {
                path,
                csrf,
                ownFiles,
                questionnaire: Boolean(questionnaire),
                query: req.query,
                signed,
                returned,
            })
        );
    };

    page.get(
        "/",
        asyncRoute(async (req, res) => {
            const { deps, row } = res.locals.portal;
            const now = deps.now();
            if (
                !row.portal_last_opened_at ||
                now - row.portal_last_opened_at >= OPEN_THROTTLE
            )
                await transition(
                    deps.db,
                    row.id,
                    (fresh) =>
                        !fresh.purged_at &&
                        (!fresh.portal_last_opened_at ||
                            now - fresh.portal_last_opened_at >= OPEN_THROTTLE)
                            ? { portal_last_opened_at: now }
                            : null,
                    { now: deps.now }
                );
            return render(req, res);
        })
    );

    page.get(
        "/sign",
        asyncRoute(async (req, res) => {
            const { deps, row } = res.locals.portal;
            const result = await carrierSigningUrl(deps, row.id);
            if (result.url) return res.redirect(303, result.url);
            return render(req, res, {
                signed: result.error === "completed",
                returned: result.error === "completed",
            });
        })
    );

    page.get(
        "/payment",
        asyncRoute(async (req, res) => {
            const { deps, row } = res.locals.portal;
            if (row.signature_state !== "COMPLETED" || row.cancelled_at)
                return closed(res);
            const result = await handleContinue(deps, null, () => ({
                requestId: row.id,
            }));
            if (result.location) return res.redirect(303, result.location);
            if (["READY", "PENDING_VERIFICATION"].includes(row.payment_state))
                return res.redirect(303, res.locals.portal.path);
            return res
                .status(result.status)
                .send(messagePage("Payment setup", result.text));
        })
    );

    page.get(
        "/agreement",
        asyncRoute(async (req, res) => {
            const { deps, row } = res.locals.portal;
            if (row.signature_state !== "COMPLETED") return closed(res);
            const result = await readSignedDocumentForRequest(deps, row.id, {
                type: "carrier",
            });
            return res
                .attachment(result.filename)
                .type("application/pdf")
                .send(result.bytes);
        })
    );

    page.get(
        "/documents/:id/file",
        asyncRoute(async (req, res) => {
            const { deps, row } = res.locals.portal;
            if (row.signature_state !== "COMPLETED") return closed(res);
            const result = await readDocumentFile(
                deps,
                row.id,
                req.params.id,
                { type: "carrier" },
                { source: "CARRIER", state: "CURRENT" }
            );
            if (!result)
                return res
                    .status(404)
                    .send(
                        messagePage(
                            "Upload unavailable",
                            "Return to your onboarding page."
                        )
                    );
            return res
                .attachment(result.filename)
                .type(result.mediaType)
                .send(result.bytes);
        })
    );

    page.get("/status.json", (req, res) => {
        const { row } = res.locals.portal;
        res.json({
            signature: row.signature_state,
            payment: row.payment_state,
            items: row.operations.map(({ key, state }) => ({ key, state })),
        });
    });

    page.post(
        "/documents/:itemKey",
        asyncRoute(async (req, res) => {
            const { deps, row, path, tokenId } = res.locals.portal;
            const { csrf, bytes, error } = await multipart(
                req,
                deps.config.files.maxBytes
            );
            if (!validCsrf(deps.config.portal.tokenSecret, tokenId, csrf))
                return denied(res);
            if (row.signature_state !== "COMPLETED" || row.cancelled_at)
                return closed(res);
            const key = req.params.itemKey;
            if (!UPLOADABLE_KEYS.includes(key))
                return res.redirect(303, path + "?error=unsupported_type");
            const result = error
                ? { code: error }
                : await recordUpload(deps, row.id, key, bytes, {
                      source: "CARRIER",
                      actor: { type: "carrier" },
                      tokenId,
                  });
            return res.redirect(
                303,
                path +
                    (result.ok
                        ? "?uploaded=" + key
                        : "?error=" + encodeURIComponent(result.code))
            );
        })
    );

    const form = express.urlencoded({
        extended: false,
        limit: "16kb",
        parameterLimit: 35,
        inflate: false,
    });
    page.post(["/not-factoring", "/questionnaire"], form, (req, res, next) => {
        const { deps, tokenId, row } = res.locals.portal;
        if (!validCsrf(deps.config.portal.tokenSecret, tokenId, req.body?.csrf))
            return denied(res);
        if (row.signature_state !== "COMPLETED" || row.cancelled_at)
            return closed(res);
        next();
    });

    page.post(
        "/not-factoring",
        asyncRoute(async (req, res) => {
            const { deps, row, path, tokenId } = res.locals.portal;
            const result = await markNotFactoring(deps, row.id, tokenId);
            return res.redirect(
                303,
                path +
                    (result.ok
                        ? "?uploaded=NOT_FACTORING"
                        : "?error=" + encodeURIComponent(result.code))
            );
        })
    );

    page.get(
        "/questionnaire",
        asyncRoute(async (req, res) => {
            const { deps, row, path, csrf } = res.locals.portal;
            if (row.signature_state !== "COMPLETED" || row.cancelled_at)
                return closed(res);
            const existing = await deps.db.onboardingQuestionnaire.findUnique({
                where: { request_id: row.id },
            });
            return res.send(
                questionnairePage(row, {
                    path,
                    csrf,
                    answers: existing?.answers,
                })
            );
        })
    );

    page.post(
        "/questionnaire",
        asyncRoute(async (req, res) => {
            const { deps, row, path, csrf, tokenId } = res.locals.portal;
            const input = { ...req.body };
            const equipment = input["equipment_types[]"];
            delete input.csrf;
            delete input["equipment_types[]"];
            if (equipment !== undefined) input.equipment_types = equipment;
            const result = await saveQuestionnaire(
                deps,
                row.id,
                input,
                tokenId
            );
            if (result.ok)
                return res.redirect(303, path + "?questionnaire=saved");
            if (result.code === "request_closed") return closed(res);
            const answers = Object.fromEntries(
                Object.entries(input).filter(
                    ([, value]) => typeof value === "string"
                )
            );
            answers.equipment_types = Array.isArray(equipment)
                ? equipment
                : [equipment];
            return res.status(422).send(
                questionnairePage(row, {
                    path,
                    csrf,
                    answers,
                    invalid: true,
                })
            );
        })
    );

    router.use("/p", (req, res) => res.status(410).send(inactivePage()));
    router.use((req, res, next) =>
        res.locals.onPortalHost ? res.status(404).end() : next()
    );

    router.use((error, req, res, next) => {
        if (!res.locals.onPortalHost) return next(error);
        if (error instanceof URIError)
            return res.status(410).send(inactivePage());
        if (error?.status === 404)
            return res
                .status(404)
                .send(
                    messagePage(
                        "File unavailable",
                        "Return to your onboarding page."
                    )
                );
        if (error?.status >= 400 && error.status < 500) return denied(res);
        return unavailable(res);
    });
    return router;
}
