import { randomUUID } from "node:crypto";
import { applyFacetChange, bumpStatus, lockRequest } from "../store.js";
import { markOperationItemReceived, slotOf } from "../readiness.js";
import { validateUpload } from "./validate.js";

export const UPLOADABLE_KEYS = [
    "W9",
    "INSURANCE_COI",
    "AUTHORITY_VERIFIED",
    "FACTORING_NOA",
];
const failure = (code) => ({ ok: false, code });

export async function carrierCanWrite(tx, row, tokenId) {
    if (!row?.portal_flow || row.purged_at || row.cancelled_at) return false;
    if (!tokenId) return true;
    return Boolean(
        await tx.portalToken.findFirst({
            where: { id: tokenId, request_id: row.id, revoked_at: null },
            select: { id: true },
        })
    );
}

async function uploadGate(tx, row, itemKey, { source, tokenId }) {
    if (!(await carrierCanWrite(tx, row, tokenId))) return "request_closed";
    const item = row.operations.find(
        (entry) => slotOf(entry.key) === slotOf(itemKey)
    );
    if (item?.state === "VERIFIED") return "already_verified";
    const current = await tx.onboardingDocument.findFirst({
        where: { request_id: row.id, item_key: itemKey, state: "CURRENT" },
        select: { id: true },
    });
    return source === "STAFF" && current && item?.state !== "REUPLOAD_REQUESTED"
        ? "document_present"
        : null;
}

export async function recordUpload(deps, requestId, itemKey, bytes, options) {
    if (!UPLOADABLE_KEYS.includes(itemKey)) return failure("unknown_item");
    if (!deps.fileStore) return failure("upload_unavailable");
    const validated = await validateUpload(bytes, {
        maxBytes: deps.config.files.maxBytes,
    });
    if (!validated.ok) return validated;
    const { db, fileStore } = deps;
    const row = await db.onboardingRequest.findUnique({
        where: { id: requestId },
    });
    const refused = await uploadGate(db, row, itemKey, options);
    if (refused) return failure(refused);
    const stored = await fileStore.put(validated.bytes);
    const documentId = randomUUID();
    let committed = false;
    try {
        const result = await db.$transaction(async (tx) => {
            const locked = await lockRequest(tx, requestId);
            const code = await uploadGate(tx, locked, itemKey, options);
            if (code) return failure(code);
            const where = { request_id: requestId, item_key: itemKey };
            const latest = await tx.onboardingDocument.findFirst({
                where,
                orderBy: { version: "desc" },
                select: { version: true },
            });
            const version = (latest?.version ?? 0) + 1;
            await tx.onboardingDocument.updateMany({
                where: { ...where, state: "CURRENT" },
                data: { state: "SUPERSEDED" },
            });
            const now = deps.now();
            await tx.onboardingDocument.create({
                data: {
                    id: documentId,
                    ...where,
                    ...stored,
                    version,
                    media_type: validated.mediaType,
                    source: options.source,
                    uploaded_by: options.actor,
                    state: "CURRENT",
                    extraction_status: deps.config.reader?.enabled
                        ? "PENDING"
                        : "DISABLED",
                    created_at: now,
                },
            });
            const operations = markOperationItemReceived(
                locked.operations,
                itemKey,
                { actor: options.actor, at: now }
            );
            const event = await applyFacetChange(
                tx,
                locked,
                { operations },
                now
            );
            if (!event.changed) await bumpStatus(tx, locked, now);
            return { ok: true, documentId, version };
        });
        committed = result.ok;
        return result;
    } catch (error) {
        // A connection can fail after commit. Keep the object if the outcome
        // cannot be established, so a retry never deletes a referenced file.
        committed = await db.onboardingDocument
            .findUnique({
                where: { id: documentId },
                select: { id: true },
            })
            .then(Boolean, () => true);
        throw error;
    } finally {
        if (!committed)
            await fileStore.delete(stored.storage_key).catch(() => {
                deps.logger?.error?.({
                    code: "onboarding_upload_cleanup_failed",
                });
            });
    }
}

export async function markNotFactoring(deps, requestId, tokenId) {
    return deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (!(await carrierCanWrite(tx, row, tokenId)))
            return failure("request_closed");
        const now = deps.now();
        const operations = markOperationItemReceived(
            row.operations,
            "NOT_FACTORING",
            { actor: { type: "carrier" }, at: now }
        );
        if (!operations) return failure("already_verified");
        await tx.onboardingDocument.updateMany({
            where: {
                request_id: requestId,
                item_key: "FACTORING_NOA",
                state: "CURRENT",
            },
            data: { state: "SUPERSEDED" },
        });
        await applyFacetChange(tx, row, { operations }, now);
        return { ok: true };
    });
}

export function rejectCurrent(tx, requestId, itemKey, reason) {
    return tx.onboardingDocument.updateMany({
        where: { request_id: requestId, item_key: itemKey, state: "CURRENT" },
        data: { state: "REJECTED", reject_reason: reason },
    });
}

export function listDocuments(db, requestId) {
    return db.onboardingDocument.findMany({
        where: {
            request_id: requestId,
            state: { in: ["CURRENT", "REJECTED"] },
            purged_at: null,
        },
        orderBy: [{ created_at: "desc" }, { version: "desc" }],
        select: {
            id: true,
            item_key: true,
            version: true,
            source: true,
            uploaded_by: true,
            state: true,
            media_type: true,
            size: true,
            created_at: true,
            extraction_status: true,
            extracted: true,
            flags: true,
            reject_reason: true,
            purged_at: true,
        },
    });
}

const extension = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/png": "png",
};

export async function readDocumentFile(
    deps,
    requestId,
    documentId,
    actor,
    filter = {}
) {
    if (!deps.fileStore) return null;
    const doc = await deps.db.onboardingDocument.findFirst({
        where: {
            ...filter,
            id: documentId,
            request_id: requestId,
            purged_at: null,
            storage_key: { not: null },
        },
    });
    if (!doc) return null;
    const bytes = await deps.fileStore.get(doc.storage_key, {
        expectedSha256: doc.sha256,
    });
    await deps.db.documentAccessLog.create({
        data: {
            request_id: requestId,
            actor,
            document: "upload:" + documentId,
            at: deps.now(),
        },
    });
    return {
        bytes,
        mediaType: doc.media_type,
        filename: "onboarding-document." + extension[doc.media_type],
    };
}
