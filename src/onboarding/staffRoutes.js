import express from "express";
import { actorSchema } from "./contracts.js";
import { MAX_UPLOAD_BYTES } from "./config.js";
import {
    listDocuments,
    readDocumentFile,
    recordUpload,
} from "./files/documents.js";
import { findRequestByKey, OnboardingError } from "./requests.js";

const MEDIA_TYPES = [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
];
const rawFile = express.raw({
    type: MEDIA_TYPES,
    limit: MAX_UPLOAD_BYTES,
    inflate: false,
    verify: (req, res, bytes) => {
        req.rawBody = bytes;
    },
});

function staffActor(res) {
    const actor = actorSchema.safeParse(res.locals.signedActor);
    if (!actor.success) throw new OnboardingError("actor_required", 422);
    return actor.data;
}

export function mountStaffRoutes(router, service, wrap) {
    router.get(
        "/requests/:key/documents",
        service,
        wrap(async (req, res, deps) => {
            staffActor(res);
            res.set("Cache-Control", "no-store");
            const row = await findRequestByKey(deps.db, req.params.key);
            const [documents, questionnaire] = await Promise.all([
                listDocuments(deps.db, row.id),
                deps.db.onboardingQuestionnaire.findUnique({
                    where: { request_id: row.id },
                    select: { answers: true },
                }),
            ]);
            const reuploadReasons = Object.fromEntries(
                row.operations
                    .filter(
                        (item) =>
                            item.state === "REUPLOAD_REQUESTED" &&
                            typeof item.note === "string"
                    )
                    .map((item) => [item.key, item.note])
            );
            res.json({
                documents,
                questionnaire: questionnaire?.answers ?? null,
                reupload_reasons: reuploadReasons,
            });
        })
    );
    router.get(
        "/requests/:key/documents/:documentId/file",
        service,
        wrap(async (req, res, deps) => {
            const actor = staffActor(res);
            res.set("Cache-Control", "no-store");
            const row = await findRequestByKey(deps.db, req.params.key);
            const result = await readDocumentFile(
                deps,
                row.id,
                req.params.documentId,
                actor
            );
            if (!result)
                throw new OnboardingError("document_not_available", 404);
            res.set(
                "Content-Disposition",
                'attachment; filename="' + result.filename + '"'
            );
            res.set("X-Content-Type-Options", "nosniff")
                .type(result.mediaType)
                .send(result.bytes);
        })
    );
    router.post(
        "/requests/:key/documents/:itemKey",
        rawFile,
        service,
        wrap(async (req, res, deps) => {
            const actor = staffActor(res);
            res.set("Cache-Control", "no-store");
            if (!req.is(MEDIA_TYPES))
                throw new OnboardingError("unsupported_type", 415);
            const row = await findRequestByKey(deps.db, req.params.key);
            const result = await recordUpload(
                deps,
                row.id,
                req.params.itemKey,
                req.body,
                { source: "STAFF", actor }
            );
            if (!result.ok) {
                const conflict = [
                    "document_present",
                    "already_verified",
                    "request_closed",
                ].includes(result.code);
                throw new OnboardingError(result.code, conflict ? 409 : 422);
            }
            res.status(201).json(result);
        })
    );
}
