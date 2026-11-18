import { z } from "zod";
import { bumpStatus, lockRequest } from "./store.js";
import { carrierCanWrite } from "./files/documents.js";

export const EQUIPMENT_TYPES = [
    "Dry van",
    "Reefer",
    "Flatbed",
    "Step deck",
    "Power only",
    "Box truck",
    "Hotshot",
    "Other",
];

const optionalNumber = (schema) =>
    z.preprocess(
        (value) =>
            value === "" || value === undefined
                ? null
                : typeof value === "string" && value.trim() !== ""
                  ? Number(value)
                  : value,
        schema.nullable()
    );
const optionalText = (limit) =>
    z.string().trim().max(limit).optional().default("");

export const questionnaireSchema = z
    .object({
        equipment_types: z.preprocess(
            (value) => (typeof value === "string" ? [value] : value),
            z
                .array(z.enum(EQUIPMENT_TYPES))
                .max(EQUIPMENT_TYPES.length)
                .optional()
                .default([])
        ),
        truck_count: optionalNumber(z.number().int().min(1).max(500)),
        home_base: optionalText(300),
        preferred_lanes: optionalText(1000),
        min_rate_per_mile: optionalNumber(z.number().finite().min(0)),
        min_rate_per_load: optionalNumber(z.number().finite().min(0)),
        excluded_freight: optionalText(500),
        max_deadhead_miles: optionalNumber(z.number().int().nonnegative()),
        availability: optionalText(300),
        other_preferences: optionalText(2000),
    })
    .strict();

export async function saveQuestionnaire(deps, requestId, input, tokenId) {
    const parsed = questionnaireSchema.safeParse(input);
    if (!parsed.success) return { ok: false, code: "invalid_answers" };
    return deps.db.$transaction(async (tx) => {
        const row = await lockRequest(tx, requestId);
        if (
            !(await carrierCanWrite(tx, row, tokenId)) ||
            row.signature_state !== "COMPLETED"
        )
            return { ok: false, code: "request_closed" };
        const now = deps.now();
        await tx.onboardingQuestionnaire.upsert({
            where: { request_id: requestId },
            create: {
                request_id: requestId,
                answers: parsed.data,
                submitted_at: now,
                updated_at: now,
            },
            update: { answers: parsed.data, updated_at: now },
        });
        await bumpStatus(tx, row, now);
        return { ok: true };
    });
}
