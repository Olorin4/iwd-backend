import { randomUUID } from "node:crypto";
import { buildStatus, deriveReadiness, facetsOf } from "./readiness.js";
import { setClientStatus } from "../clients/index.js";

export const STATUS_EVENT = "onboarding.status.v1";

const FACET_FIELDS = [
    "signature_state",
    "signature_code",
    "signature_at",
    "payment_state",
    "payment_code",
    "payment_method_type",
    "payment_last4",
    "payment_at",
    "provisioning_state",
    "provisioning_code",
    "kelevo_ref",
    "provisioning_at",
    "operations",
    "cancelled_at",
    "bundle_version_id",
];

const same = (a, b) => {
    if (a instanceof Date || b instanceof Date)
        return (
            (a ? new Date(a).getTime() : null) ===
            (b ? new Date(b).getTime() : null)
        );
    return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
};

export async function signedAvailable(db, requestId) {
    const count = await db.signatureEnvelope.count({
        where: {
            request_id: requestId,
            state: "COMPLETED",
            completed_storage_key: { not: null },
        },
    });
    return count > 0;
}

/** Writes the status event for the row's current version (same transaction). */
export async function writeStatusEvent(tx, row, now) {
    const eventId = randomUUID();
    const payload = buildStatus(row, {
        eventId,
        occurredAt: now,
        signedAvailable: await signedAvailable(tx, row.id),
    });
    await tx.onboardingEvent.create({
        data: {
            event_id: eventId,
            request_id: row.id,
            type: STATUS_EVENT,
            version: row.version,
            payload,
            next_attempt_at: now,
            created_at: now,
        },
    });
    return payload;
}

/** An audit-only event (never delivered to Outreach). */
export const writeAuditEvent = (tx, row, type, payload, now = new Date()) =>
    tx.onboardingEvent.create({
        data: {
            event_id: randomUUID(),
            request_id: row.id,
            type,
            version: row.version,
            payload,
            created_at: now,
        },
    });

export async function lockRequest(tx, requestId) {
    await tx.$queryRaw`SELECT "id" FROM "onboarding_request" WHERE "id" = ${requestId} FOR UPDATE`;
    return tx.onboardingRequest.findUnique({ where: { id: requestId } });
}

/**
 * Applies facet changes to a locked row. A real change bumps `version`, writes
 * the full status event and marks the Client ACTIVE once readiness is READY.
 * Returns { row, changed, status }.
 */
export async function applyFacetChange(tx, row, changes, now = new Date()) {
    const data = {};
    for (const [key, value] of Object.entries(changes ?? {})) {
        if (!FACET_FIELDS.includes(key))
            throw new Error(`not_a_facet_field:${key}`);
        if (!same(row[key], value)) data[key] = value;
    }
    if (Object.keys(data).length === 0)
        return { row, changed: false, status: null };
    const updated = await tx.onboardingRequest.update({
        where: { id: row.id },
        data: { ...data, version: { increment: 1 } },
    });
    const status = await writeStatusEvent(tx, updated, now);
    if (deriveReadiness(facetsOf(updated)).readiness === "READY")
        await setClientStatus(tx, updated.client_id, "ACTIVE");
    return { row: updated, changed: true, status };
}

/**
 * Locks the request, lets `decide(row, tx)` return facet changes (or null),
 * and applies them atomically.
 */
export function transition(
    db,
    requestId,
    decide,
    { now = () => new Date() } = {}
) {
    return db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (!row) throw new Error("request_not_found");
        const changes = await decide(row, tx);
        return applyFacetChange(tx, row, changes, now());
    });
}

/** The current status projection (for GET): the latest status event's payload. */
export async function currentStatus(db, row) {
    const latest = await db.onboardingEvent.findFirst({
        where: { request_id: row.id, type: STATUS_EVENT },
        orderBy: [{ version: "desc" }, { created_at: "desc" }],
    });
    return buildStatus(row, {
        eventId: latest?.event_id ?? randomUUID(),
        occurredAt: latest?.created_at ?? row.updated_at,
        signedAvailable: await signedAvailable(db, row.id),
    });
}

/** Records a provider/replay receipt. Returns false when it already existed. */
export async function recordReceipt(db, provider, key) {
    try {
        await db.providerWebhookReceipt.create({
            data: { provider, receipt_key: `${provider}:${key}`.slice(0, 500) },
        });
        return true;
    } catch (error) {
        if (error?.code === "P2002") return false;
        throw error;
    }
}

export async function receiptExists(db, provider, key) {
    const row = await db.providerWebhookReceipt.findUnique({
        where: { receipt_key: `${provider}:${key}`.slice(0, 500) },
    });
    return !!row;
}

export const REPLAY_RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes Outreach replay receipts (`outreach:v2:*`) older than `before`, at
 * most `limit` per call. Signatures are only valid for ±300 s, so a day is
 * ample. Provider (Stripe/SignWell) receipts are kept. Returns the count.
 */
export function pruneReplayReceipts(db, before, limit = 1000) {
    return db.$executeRaw`
        DELETE FROM "provider_webhook_receipt"
        WHERE "id" IN (
            SELECT "id" FROM "provider_webhook_receipt"
            WHERE "provider" = 'outreach'
              AND "receipt_key" LIKE 'outreach:v2:%'
              AND "received_at" < ${before}
            LIMIT ${limit}
        )`;
}
