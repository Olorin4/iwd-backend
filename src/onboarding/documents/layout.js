import { z } from "zod";

// Field layout for a bundle file, in the reviewed draft format
// (docs/operations/onboarding-layouts/*.layout.draft.json):
//   units: PDF points, origin TOP-LEFT of the page; each field is a box
//   { page (1-based), x, y, w, h }.
//   kind "stamp":       text value `key` drawn into the box (size, min_size ≥ 7).
//   kind "stamp_check": glyph (default "X") drawn when `key` matches `when`.
//   kind "signwell":    a provider field for recipient 1 (Carrier) or 2 (Dispatch).
// The filler converts boxes to pdf-lib's bottom-left origin; the SignWell
// adapter converts them through its single configurable calibration.
export const STAMP_KEYS = [
    "effective_date",
    "legal_name",
    "dba_name",
    "mc_number",
    "usdot",
    "fleet_fee_percent",
    "fleet_service_plan",
    "dispatch_contact_name",
    "carrier_contact_name",
    "carrier_signer_name",
    "start_month",
    "start_day",
    "start_year2",
    "statement_email",
];
export const CHECK_KEYS = ["plan", "payment_methods", "primary_payment_method"];
export const MIN_FONT_SIZE = 7;

const n = z.number().finite().min(0).max(5000);
const box = {
    page: z.number().int().min(1),
    x: n,
    y: n,
    w: z.number().positive().max(5000),
    h: z.number().positive().max(5000),
    note: z.string().max(300).optional(),
};

const stamp = z
    .object({
        ...box,
        kind: z.literal("stamp"),
        key: z.enum(STAMP_KEYS),
        font: z.literal("Helvetica").default("Helvetica"),
        size: z.number().min(MIN_FONT_SIZE).max(24).default(10),
        min_size: z.number().min(MIN_FONT_SIZE).max(24).default(MIN_FONT_SIZE),
        format: z.string().max(60).optional(),
    })
    .strict()
    .refine((f) => f.min_size <= f.size, { message: "min_size above size" });

const check = z
    .object({
        ...box,
        kind: z.literal("stamp_check"),
        key: z.enum(CHECK_KEYS),
        when: z.enum([
            "ESSENTIAL",
            "FULL_SERVICE",
            "FLEET",
            "card",
            "us_bank_account",
        ]),
        glyph: z.string().length(1).default("X"),
    })
    .strict();

const signwell = z
    .object({
        ...box,
        kind: z.literal("signwell"),
        recipient: z.union([z.literal(1), z.literal(2)]),
        type: z.string().regex(/^(signature|initials|date|text)\b/),
    })
    .strict();

const fileLayout = z
    .object({
        bundle: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.pdf$/),
        sha256: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .optional(),
        status: z.string().max(20).optional(),
        units: z.string().max(200).optional(),
        fields: z
            .array(
                z.discriminatedUnion("kind", [
                    stamp.innerType(),
                    check,
                    signwell,
                ])
            )
            .min(1)
            .max(400),
    })
    .strict()
    .superRefine((layout, ctx) => {
        for (const [index, f] of layout.fields.entries()) {
            const parsed = (
                f.kind === "stamp"
                    ? stamp
                    : f.kind === "stamp_check"
                      ? check
                      : signwell
            ).safeParse(f);
            if (!parsed.success)
                ctx.addIssue({
                    code: "custom",
                    path: ["fields", index],
                    message: "invalid field",
                });
        }
    });

/** One layout object, or an array of them (one per bundle file). */
export const layoutSchema = z
    .union([
        fileLayout.transform((l) => [l]),
        z.array(fileLayout).min(1).max(10),
    ])
    .refine(
        (files) =>
            [1, 2].every((r) =>
                files.some((l) =>
                    l.fields.some(
                        (f) =>
                            f.kind === "signwell" &&
                            f.recipient === r &&
                            f.type.startsWith("signature")
                    )
                )
            ),
        {
            message:
                "the layout needs a Carrier (1) and a Dispatch (2) signature field",
        }
    );
