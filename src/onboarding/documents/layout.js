import { z } from "zod";

// Field layout for one document bundle version. Two coordinate systems:
// - stamps: PDF points, origin bottom-left of the page (pdf-lib drawText),
//   page numbers 1-based. Text only; nothing else on the page changes.
// - fields: signature-provider fields passed through to SignWell (its
//   coordinates: x/y from the top-left of the page, page 1-based).
export const STAMP_VALUES = [
    "effective_date",
    "legal_name",
    "dba_name",
    "mc_number",
    "usdot",
    "plan_label",
    "fee_percent",
    "plan_and_fee",
    "payment_choice",
    "signer_name",
    "signer_title",
    "signer_name_title",
    "mark", // draws "X" when `when` matches (plan box, payment method box)
];

const coordinate = z.number().finite().min(0).max(5000);

const stamp = z
    .object({
        value: z.enum(STAMP_VALUES),
        page: z.number().int().min(1),
        x: coordinate,
        y: coordinate,
        size: z.number().min(4).max(24).default(10),
        max_width: z.number().positive().max(5000).optional(),
        when: z
            .object({
                plan: z
                    .array(z.enum(["ESSENTIAL", "FULL_SERVICE", "CUSTOM"]))
                    .min(1)
                    .optional(),
                payment_method: z.enum(["card", "us_bank_account"]).optional(),
            })
            .strict()
            .optional(),
    })
    .strict()
    .refine((s) => s.value !== "mark" || s.when, {
        message: "a mark needs a condition",
    });

const field = z
    .object({
        type: z.enum(["signature", "initials", "date", "name", "text"]),
        recipient: z.enum(["carrier", "dispatch"]),
        page: z.number().int().min(1),
        x: coordinate,
        y: coordinate,
        width: z.number().positive().max(2000).optional(),
        height: z.number().positive().max(2000).optional(),
        required: z.boolean().default(true),
        label: z.string().max(100).optional(),
    })
    .strict();

export const layoutSchema = z
    .object({
        files: z
            .array(
                z
                    .object({
                        name: z.string().regex(/^[A-Za-z0-9._-]{1,120}\.pdf$/),
                        stamps: z.array(stamp).max(200),
                        fields: z.array(field).max(200),
                    })
                    .strict()
            )
            .min(1)
            .max(10),
    })
    .strict()
    .refine(
        (l) =>
            l.files.some((f) =>
                f.fields.some(
                    (x) => x.type === "signature" && x.recipient === "carrier"
                )
            ) &&
            l.files.some((f) =>
                f.fields.some(
                    (x) => x.type === "signature" && x.recipient === "dispatch"
                )
            ),
        { message: "the layout needs a Carrier and a Dispatch signature field" }
    );
