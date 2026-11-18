import { Prisma } from "@prisma/client";
import { bumpStatus, lockRequest } from "../store.js";
import { computeFlags } from "./flags.js";
import { DOCUMENT_SCHEMAS, stripTinLike } from "./schemas.js";

const STALE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export async function readPendingDocuments(deps) {
    const counts = { done: 0, failed: 0 };
    if (
        !deps.config.reader?.enabled ||
        !deps.fileStore ||
        !deps.extractDocument
    )
        return counts;
    const { db } = deps;
    const freeClaim = {
        extraction_status: "PENDING",
        purged_at: null,
        storage_key: { not: null },
        OR: [
            { extraction_claimed_at: null },
            {
                extraction_claimed_at: {
                    lt: new Date(deps.now().getTime() - STALE_MS),
                },
            },
        ],
    };
    const docs = await db.onboardingDocument.findMany({
        where: {
            ...freeClaim,
            request: { purged_at: null, cancelled_at: null },
        },
        orderBy: { created_at: "asc" },
        take: 5,
        include: { request: { select: { terms: true } } },
    });
    for (const doc of docs) {
        const claim = deps.now();
        const attempt = doc.extraction_attempts + 1;
        const claimed = await db.onboardingDocument.updateMany({
            where: {
                id: doc.id,
                ...freeClaim,
                extraction_attempts: doc.extraction_attempts,
            },
            data: {
                extraction_claimed_at: claim,
                extraction_attempts: attempt,
            },
        });
        if (claimed.count !== 1) continue;

        let data = { extraction_claimed_at: null };
        try {
            if (attempt > MAX_ATTEMPTS)
                throw new Error("reader_attempts_exhausted");
            const bytes = await deps.fileStore.get(doc.storage_key, {
                expectedSha256: doc.sha256,
            });
            const response = await deps.extractDocument(doc.item_key, {
                bytes,
                mediaType: doc.media_type,
            });
            const parsed = DOCUMENT_SCHEMAS[doc.item_key].parse(response);
            const extracted = stripTinLike(parsed);
            data = {
                ...data,
                extracted,
                flags: computeFlags(
                    doc.item_key,
                    extracted,
                    doc.request.terms,
                    deps.now()
                ),
                extraction_status: "DONE",
            };
        } catch {
            if (attempt >= MAX_ATTEMPTS)
                data = {
                    ...data,
                    extracted: Prisma.DbNull,
                    flags: ["unreadable"],
                    extraction_status: "FAILED",
                };
        }
        const outcome = await db.$transaction(async (tx) => {
            const row = await lockRequest(tx, doc.request_id);
            if (row.purged_at) return null;
            const result = await tx.onboardingDocument.updateMany({
                where: {
                    id: doc.id,
                    extraction_claimed_at: claim,
                    extraction_attempts: attempt,
                    purged_at: null,
                },
                data,
            });
            if (!result.count || !data.extraction_status) return null;
            await bumpStatus(tx, row, deps.now());
            return data.extraction_status;
        });
        if (outcome === "DONE") counts.done++;
        if (outcome === "FAILED") counts.failed++;
    }
    return counts;
}
