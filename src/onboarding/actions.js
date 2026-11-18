import { z } from "zod";
import { actorSchema } from "./contracts.js";
import { OnboardingError, findRequestByKey } from "./requests.js";
import { currentStatus, transition, writeAuditEvent } from "./store.js";
import { verifyOperationItem } from "./readiness.js";
import {
    REISSUABLE,
    reconcileSignature,
    reissuePacket,
} from "./signatureFlow.js";
import { issuePaymentLink, reconcilePayment } from "./paymentFlow.js";
import { confirmProvisioning, startProvisioning } from "./provisioningFlow.js";
import { recoverRequestSteps } from "./recovery.js";

const base = { actor: actorSchema };
const SCHEMAS = {
    reconcile: z.object(base).strict(),
    resend_payment_link: z.object(base).strict(),
    reissue_packet: z.object(base).strict(),
    retry_provisioning: z.object(base).strict(),
    confirm_provisioning: z
        .object({
            ...base,
            kelevo_ref: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
        })
        .strict(),
    verify_operation_item: z
        .object({
            ...base,
            key: z.enum([
                "AUTHORITY_VERIFIED",
                "INSURANCE_COI",
                "W9",
                "FACTORING_NOA",
                "NOT_FACTORING",
                "CARRIER_PROFILE",
                "FLEET_MAPPING",
            ]),
            note: z.string().max(500).nullable().optional(),
        })
        .strict(),
    cancel: z
        .object({ ...base, reason: z.string().max(500).nullable().optional() })
        .strict(),
};
export const ACTION_NAMES = Object.keys(SCHEMAS);

const OPEN_ENVELOPE = ["SENDING", "UNKNOWN", "SENT", "VIEWED"];

async function cancel(deps, row) {
    const now = deps.now();
    const result = await transition(deps.db, row.id, (r) =>
        r.cancelled_at ? null : { cancelled_at: now }
    );
    if (!result.changed) return false;
    // Best effort: withdraw an open packet and an open Checkout session.
    const envelope = await deps.db.signatureEnvelope.findFirst({
        where: {
            request_id: row.id,
            superseded_by: null,
            state: { in: OPEN_ENVELOPE },
        },
    });
    if (envelope?.provider_document_id) {
        try {
            await deps.signature.delete(envelope.provider_document_id);
            await deps.db.signatureEnvelope.update({
                where: { id: envelope.id },
                data: { state: "CANCELLED" },
            });
        } catch (error) {
            deps.logger?.error?.({
                code: "onboarding_cancel_withdraw_failed",
                reason: error?.code ?? "error",
            });
        }
    }
    const setups = await deps.db.paymentSetup.findMany({
        where: { request_id: row.id, state: "OPEN" },
    });
    for (const setup of setups) {
        await deps.db.paymentSetup.update({
            where: { id: setup.id },
            data: { state: "SUPERSEDED" },
        });
        if (setup.checkout_session_id)
            await deps.stripe
                .expireCheckoutSession(setup.checkout_session_id)
                .catch(() => null);
    }
    return true;
}

async function perform(deps, row, action, input) {
    const notAllowed = (code) => {
        throw new OnboardingError("action_not_allowed", 409, { code });
    };
    if (row.cancelled_at && action !== "reconcile")
        notAllowed("request_cancelled");
    switch (action) {
        case "reconcile":
            await reconcileSignature(deps, row.id);
            await reconcilePayment(deps, row.id);
            await recoverRequestSteps(deps, row.id);
            return "reconciled";
        case "resend_payment_link": {
            const result = await issuePaymentLink(deps, row.id, {
                mode: "resend",
            });
            if (result.skipped) notAllowed(result.skipped);
            return "link_issued";
        }
        case "reissue_packet": {
            const envelope = await deps.db.signatureEnvelope.findFirst({
                where: {
                    request_id: row.id,
                    superseded_by: null,
                    state: { not: "ABANDONED" },
                },
            });
            if (!envelope || !REISSUABLE.includes(envelope.state))
                notAllowed("packet_not_reissuable");
            if (!(await reissuePacket(deps, row.id)))
                notAllowed("packet_not_reissuable");
            return "packet_reissued";
        }
        case "retry_provisioning":
            if (!(await startProvisioning(deps, row.id, { retry: true })))
                notAllowed("provisioning_not_retryable");
            return "provisioning_retried";
        case "confirm_provisioning":
            if (!(await confirmProvisioning(deps, row.id, input.kelevo_ref)))
                notAllowed("provisioning_not_manual");
            return "provisioning_confirmed";
        case "verify_operation_item": {
            const now = deps.now();
            await transition(deps.db, row.id, (r) => ({
                operations: verifyOperationItem(r.operations, input.key, {
                    actor: input.actor,
                    note: input.note ?? null,
                    at: now,
                }),
            }));
            return "item_verified";
        }
        case "cancel":
            if (!(await cancel(deps, row))) notAllowed("already_cancelled");
            return "cancelled";
        default:
            throw new OnboardingError("not_found", 404);
    }
}

/**
 * POST /onboarding/requests/:key/actions/:action. Every attempt, allowed or
 * not, is audited with its actor. Returns the current onboarding.status.v1.
 */
export async function runAction(deps, key, action, body) {
    const schema = SCHEMAS[action];
    if (!schema) throw new OnboardingError("not_found", 404);
    const parsed = schema.safeParse(body ?? {});
    if (!parsed.success)
        throw new OnboardingError("invalid_request", 422, {
            issues: parsed.error.issues.map((i) => ({
                path: i.path.join("."),
                code: i.code,
            })),
        });
    const row = await findRequestByKey(deps.db, key);
    const { actor, ...params } = parsed.data;
    let outcome;
    try {
        outcome = await perform(deps, row, action, parsed.data);
    } catch (error) {
        outcome =
            error instanceof OnboardingError
                ? `refused:${error.extra?.code ?? error.code}`
                : "failed";
        await writeAuditEvent(
            deps.db,
            row,
            `audit.action.${action}`,
            { action, actor, params, outcome },
            deps.now()
        );
        throw error;
    }
    await writeAuditEvent(
        deps.db,
        row,
        `audit.action.${action}`,
        { action, actor, params, outcome },
        deps.now()
    );
    const fresh = await deps.db.onboardingRequest.findUnique({
        where: { id: row.id },
    });
    return currentStatus(deps.db, fresh);
}

/** Decrypts the completed packet for an authenticated, audited download. */
export async function readSignedDocument(deps, key, actor) {
    const parsedActor = actorSchema.safeParse(actor);
    if (!parsedActor.success) throw new OnboardingError("actor_required", 422);
    const row = await findRequestByKey(deps.db, key);
    const envelope = await deps.db.signatureEnvelope.findFirst({
        where: {
            request_id: row.id,
            state: "COMPLETED",
            completed_storage_key: { not: null },
        },
        orderBy: { completed_at: "desc" },
    });
    if (!envelope) throw new OnboardingError("document_not_available", 404);
    const bytes = await deps.documentStore.get(envelope.completed_storage_key, {
        expectedSha256: envelope.completed_sha256,
    });
    await deps.db.documentAccessLog.create({
        data: {
            request_id: row.id,
            actor: parsedActor.data,
            document: `signed_packet:${envelope.id}`,
        },
    });
    return {
        bytes,
        filename: `signed-packet-${row.id}.pdf`,
        sha256: envelope.completed_sha256,
    };
}
