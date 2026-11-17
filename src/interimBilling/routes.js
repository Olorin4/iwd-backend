// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import express from "express";
import { body, param, query, validationResult } from "express-validator";
import { requireInterimAdmin } from "./adminAuth.js";
import { createCarrier, sendSetupLink } from "./carriers.js";
import {
    startRun,
    setLinehaul,
    decideCancelled,
    approveRun,
} from "./runService.js";
import { chargeApprovedRun, runDueRetries } from "./charger.js";
import { createWebhookHandler } from "./webhook.js";
export function createInterimBillingRouter(getConfig, getDeps) {
    const router = express.Router();
    const safe = (fn) => async (req, res) => {
        if (!validationResult(req).isEmpty())
            return res.status(400).json({ error: "invalid_input" });
        try {
            return await fn(req, res, getDeps());
        } catch (error) {
            return res.status(error.status ?? 500).json({
                error:
                    typeof error.code === "string" &&
                    /^[a-z_]{1,80}$/.test(error.code)
                        ? error.code
                        : "billing_failed",
            });
        }
    };
    router.post(
        "/webhook",
        safe(async (req, res, deps) => {
            await createWebhookHandler(deps)(req, res);
            if (res.statusCode === 200)
                try {
                    await (deps.runDueRetries ?? runDueRetries)(
                        new Date(),
                        deps
                    );
                } catch {
                    /* Durable retries are picked up by the next tick. */
                }
        })
    );
    router.use(requireInterimAdmin(getConfig));
    const id = () => param("id").isInt({ min: 1, max: 2147483647 }).toInt();
    router.post(
        "/carriers",
        body().isObject(),
        safe(async (req, res, deps) =>
            res
                .status(201)
                .json(
                    await (deps.createCarrier ?? createCarrier)(req.body, deps)
                )
        )
    );
    router.post(
        "/carriers/:id/setup-link",
        id(),
        body("role").isIn(["primary", "backup"]),
        safe(async (req, res, deps) =>
            res.json(
                await (deps.sendSetupLink ?? sendSetupLink)(
                    req.params.id,
                    req.body.role,
                    deps
                )
            )
        )
    );
    router.post(
        "/runs",
        query("dryRun").optional().isIn(["true", "false"]),
        safe(async (req, res, deps) =>
            res.json(
                await (deps.startRun ?? startRun)(
                    { now: new Date(), dryRun: req.query.dryRun === "true" },
                    deps
                )
            )
        )
    );
    router.get(
        "/runs/:id",
        id(),
        safe(async (req, res, deps) => {
            const run = await deps.store.getRun(req.params.id);
            if (!run) return res.status(404).json({ error: "run_not_found" });
            res.json({
                run,
                invoices: await deps.store.listInvoicesForRun(run.id),
                lines: await deps.store.listLinesForRun(run.id),
            });
        })
    );
    router.post(
        "/runs/:id/approve",
        id(),
        body("invoiceCount").isInt({ min: 0, max: 2147483647 }).toInt(),
        body("totalCents").isInt({ min: 0, max: 2147483647 }).toInt(),
        safe(async (req, res, deps) => {
            await (deps.approveRun ?? approveRun)(
                req.params.id,
                req.body,
                "admin token",
                deps
            );
            await (deps.chargeApprovedRun ?? chargeApprovedRun)(
                req.params.id,
                deps
            );
            res.json({ approved: true });
        })
    );
    router.post(
        "/lines/:id/linehaul",
        id(),
        body("amount")
            .isString()
            .matches(/^\d+(?:\.\d{1,2})?$/),
        body("note").isString().isLength({ min: 1, max: 500 }),
        safe(async (req, res, deps) => {
            await (deps.setLinehaul ?? setLinehaul)(
                req.params.id,
                req.body.amount,
                req.body.note,
                deps
            );
            res.json({ updated: true });
        })
    );
    router.post(
        "/lines/:id/decide",
        id(),
        body("charge").isBoolean({ strict: true }),
        safe(async (req, res, deps) => {
            await (deps.decideCancelled ?? decideCancelled)(
                req.params.id,
                req.body.charge,
                deps
            );
            res.json({ updated: true });
        })
    );
    return router;
}
