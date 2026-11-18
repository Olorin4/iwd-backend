import { Prisma } from "@prisma/client";
import {
    abandonedPurgeDate,
    bumpStatus,
    completedPurgeDate,
    lockRequest,
    writeAuditEvent,
} from "./store.js";
import { deriveReadiness, facetsOf } from "./readiness.js";

const nyDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    dateStyle: "short",
});
const nyHour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hourCycle: "h23",
    hour: "numeric",
});

export function retentionDay(now) {
    return Number(nyHour.format(now)) >= 3 ? nyDate.format(now) : null;
}

async function deleteEnvelopeFiles(store, envelope) {
    let removed = 0;
    if (envelope.completed_storage_key) {
        await store.delete(envelope.completed_storage_key);
        removed++;
    }
    if (envelope.filled_storage_key) {
        let manifest;
        try {
            const bytes = await store.get(envelope.filled_storage_key, {
                expectedSha256: envelope.filled_sha256,
            });
            manifest = JSON.parse(bytes.toString("utf8"));
        } catch (error) {
            if (error?.code !== "document_missing") throw error;
        }
        for (const file of manifest?.files ?? []) {
            await store.delete(file.storage_key);
            removed++;
        }
        await store.delete(envelope.filled_storage_key);
        removed++;
    }
    return removed;
}

// Requests that ended before retention dates existed (or before the portal
// release) get them on the first pass: cancelled → 90 days after
// cancellation; READY → 3 years after its last change (the best record of
// when it became READY).
export async function backfillRetention(db) {
    const rows = await db.onboardingRequest.findMany({
        where: { purge_after: null, purged_at: null },
    });
    let dated = 0;
    for (const row of rows) {
        let data = null;
        if (row.cancelled_at && !row.ready_at)
            data = { purge_after: abandonedPurgeDate(row.cancelled_at) };
        else if (
            !row.cancelled_at &&
            deriveReadiness(facetsOf(row)).readiness === "READY"
        ) {
            const readyAt = row.ready_at ?? row.updated_at;
            data = {
                ready_at: readyAt,
                purge_after: completedPurgeDate(readyAt),
            };
        }
        if (!data) continue;
        const result = await db.onboardingRequest.updateMany({
            where: { id: row.id, purge_after: null },
            data,
        });
        dated += result.count;
    }
    return dated;
}

export async function purgeDue(deps, now = deps.now()) {
    const { db } = deps;
    await backfillRetention(db);
    const due = await db.onboardingRequest.findMany({
        where: { purge_after: { lte: now }, purged_at: null },
        select: { id: true },
        orderBy: { purge_after: "asc" },
    });
    let purged = 0;
    for (const { id } of due) {
        try {
            const complete = await db.$transaction(
                async (tx) => {
                    const row = await lockRequest(tx, id);
                    if (
                        !row ||
                        row.purged_at ||
                        !row.purge_after ||
                        row.purge_after > now
                    )
                        return false;
                    const [documents, envelopes] = await Promise.all([
                        tx.onboardingDocument.findMany({
                            where: { request_id: id },
                            select: { storage_key: true },
                        }),
                        tx.signatureEnvelope.findMany({
                            where: { request_id: id },
                        }),
                    ]);
                    const keys = documents
                        .map((doc) => doc.storage_key)
                        .filter(Boolean);
                    if (keys.length && !deps.fileStore) return false;
                    for (const key of keys) await deps.fileStore.delete(key);
                    let envelopeFiles = 0;
                    for (const envelope of envelopes)
                        envelopeFiles += await deleteEnvelopeFiles(
                            deps.documentStore,
                            envelope
                        );
                    await tx.onboardingDocument.updateMany({
                        where: { request_id: id },
                        data: {
                            storage_key: null,
                            extracted: Prisma.DbNull,
                            flags: Prisma.DbNull,
                            reject_reason: null,
                            purged_at: now,
                        },
                    });
                    const questionnaire =
                        await tx.onboardingQuestionnaire.deleteMany({
                            where: { request_id: id },
                        });
                    await tx.signatureEnvelope.updateMany({
                        where: { request_id: id },
                        data: {
                            completed_storage_key: null,
                            filled_storage_key: null,
                        },
                    });
                    const tokens = await tx.portalToken.updateMany({
                        where: { request_id: id, revoked_at: null },
                        data: { revoked_at: now },
                    });
                    const updated = await tx.onboardingRequest.update({
                        where: { id },
                        data: {
                            purged_at: now,
                            operations: row.operations.map((item) => ({
                                ...item,
                                note: null,
                            })),
                        },
                    });
                    await bumpStatus(tx, updated, now);
                    await writeAuditEvent(
                        tx,
                        updated,
                        "onboarding.purged",
                        {
                            documents: documents.length,
                            envelope_files: envelopeFiles,
                            questionnaire: questionnaire.count,
                            tokens: tokens.count,
                        },
                        now
                    );
                    return true;
                },
                { timeout: 120000 }
            );
            if (complete) purged++;
        } catch {
            deps.logger?.error?.({ code: "onboarding_purge_failed" });
        }
    }
    return { purged };
}
