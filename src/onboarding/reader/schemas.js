import { z } from "zod/v4";

const text = z.string().nullable();
const date = z.iso.date().nullable();
const match = { document_type_matches: z.boolean() };

export const w9Schema = z.strictObject({
    ...match,
    legal_name: text,
    business_name: text,
    entity_type: text,
    tin_type: z.enum(["SSN", "EIN"]).nullable(),
    tin_last4: z
        .string()
        .regex(/^\d{4}$/)
        .nullable(),
    address: text,
    signature_present: z.boolean(),
    signature_date: date,
});

export const coiSchema = z.strictObject({
    ...match,
    insurers: z.array(z.string()),
    policies: z.array(
        z.strictObject({
            coverage: z.enum([
                "AUTO_LIABILITY",
                "CARGO",
                "GENERAL_LIABILITY",
                "OTHER",
            ]),
            policy_number: text,
            limit_usd: z.number().nullable(),
            effective_date: date,
            expiry_date: date,
        })
    ),
    certificate_holder: text,
    named_insured: text,
});

export const authoritySchema = z.strictObject({
    ...match,
    mc_number: text,
    usdot: text,
    legal_name: text,
    authority_type: text,
    granted_date: date,
});

export const noaSchema = z.strictObject({
    ...match,
    factoring_company: text,
    remittance_address: text,
    contact_email: text,
    contact_phone: text,
    effective_date: date,
    carrier_name: text,
});

export const DOCUMENT_SCHEMAS = {
    W9: w9Schema,
    INSURANCE_COI: coiSchema,
    AUTHORITY_VERIFIED: authoritySchema,
    FACTORING_NOA: noaSchema,
};

// Full tax-ID shapes: SSN 3-2-4 and EIN 2-7, each separator optional (space,
// dot, hyphens/dashes). Over-matching is the safe side, with one exception: a
// ZIP+4 right after a state code ("TX 75201-4567") is an address, not a TIN.
const TIN_LIKE =
    /(?<!\d)(?:\d{3}[\s.‐‑‒–—-]?\d{2}[\s.‐‑‒–—-]?\d{4}|\d{2}[\s.‐‑‒–—-]?\d{7})(?!\d)/;
const STATE_ZIP4 = /\b[A-Z]{2},?\s+\d{5}-\d{4}(?!\d)/g;

// Remove full tax-ID shapes in free text throughout the parsed object. Also
// handle nine-digit JSON numbers and defensive sanitization of key names.
export function stripTinLike(value) {
    if (typeof value === "string" || typeof value === "number")
        return TIN_LIKE.test(String(value).replace(STATE_ZIP4, " "))
            ? null
            : value;
    if (Array.isArray(value))
        return value.map(stripTinLike).filter((entry) => entry !== null);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => !TIN_LIKE.test(key))
                .map(([key, entry]) => [key, stripTinLike(entry)])
        );
    return value;
}
