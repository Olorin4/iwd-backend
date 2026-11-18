// Zod mirror of the cross-application contracts defined by Outreach in
// packages/contracts/src/sales.ts (design §6). Fixtures under
// docs/contracts/fixtures/ are byte-identical copies checked by tests.
import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const nullableIso = iso.nullable();
const shortText = (max) =>
    // No transforms: the stored terms must equal what the sender hashed.
    z
        .string()
        .min(1)
        .max(max)
        .refine((v) => v.trim() === v && v.length > 0, {
            message: "untrimmed text",
        })
        .refine(
            (v) =>
                ![...v].some(
                    (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
                ),
            {
                message: "control characters are not allowed",
            }
        );

const isRealDate = (value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
};

export const PLAN_FEES = { ESSENTIAL: 500, FULL_SERVICE: 1000 };
export const PAYMENT_METHODS = ["card", "us_bank_account"];

export const termsSchema = z
    .object({
        path: z.literal("IRON_WING_CARRIER_CLIENT"),
        legal_name: shortText(200),
        dba_name: shortText(200).nullable(),
        mc_number: z
            .string()
            .regex(/^(MC)?\d{1,8}$/i)
            .nullable(),
        usdot: z.string().regex(/^\d{1,8}$/),
        recipient_email: z.string().email().max(254),
        signer: z
            .object({
                name: shortText(120),
                title: shortText(120),
                email: z.string().email().max(254),
            })
            .strict(),
        plan: z.enum(["ESSENTIAL", "FULL_SERVICE", "CUSTOM"]),
        fee_bp: z.number().int().min(1).max(3000),
        effective_date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .refine(isRealDate),
        payment_methods: z
            .array(z.enum(PAYMENT_METHODS))
            .min(1)
            .max(2)
            .refine((list) => new Set(list).size === list.length, {
                message: "duplicate payment method",
            }),
        notes_for_packet: z.string().max(2000).nullable(),
    })
    .strict()
    .refine((t) => t.plan === "CUSTOM" || PLAN_FEES[t.plan] === t.fee_bp, {
        message: "fee_bp does not match the plan",
        path: ["fee_bp"],
    });

export const onboardingRequestV1 = z
    .object({
        contract: z.literal("onboarding.request.v1"),
        idempotency_key: z.string().uuid(),
        source: z.literal("outreach"),
        source_refs: z
            .object({
                workspace_id: z.string().min(1).max(100),
                brand: z.string().min(1).max(100),
                opportunity_id: z.string().min(1).max(100),
                party_id: z.string().min(1).max(100),
                request_id: z.string().min(1).max(100),
            })
            .strict(),
        actor: z
            .object({
                user_id: z.string().min(1).max(100),
                email: z.string().email().max(254),
            })
            .strict(),
        terms: termsSchema,
        terms_hash: z.string().min(1).max(128),
        confirmed_at: iso,
    })
    .strict();

export const SIGNATURE_STATES = [
    "NOT_SENT",
    "SENDING",
    "UNKNOWN",
    "SENT",
    "VIEWED",
    "COMPLETED",
    "DECLINED",
    "EXPIRED",
    "CANCELLED",
    "ERROR",
];
export const PAYMENT_STATES = [
    "NOT_STARTED",
    "LINK_SENT",
    "PENDING_VERIFICATION",
    "READY",
    "FAILED",
];
export const PROVISIONING_STATES = [
    "NOT_STARTED",
    "PENDING",
    "SUCCEEDED",
    "FAILED",
    "MANUAL_REQUIRED",
    "MANUAL_CONFIRMED",
];
export const OPERATION_KEYS = [
    "AUTHORITY_VERIFIED",
    "INSURANCE_COI",
    "W9",
    "FACTORING_NOA",
    "NOT_FACTORING",
    "CARRIER_PROFILE",
    "FLEET_MAPPING",
];
export const ACTIONS = [
    "resend_payment_link",
    "retry_provisioning",
    "confirm_provisioning",
    "reissue_packet",
    "reconcile",
];

export const onboardingStatusV1 = z
    .object({
        contract: z.literal("onboarding.status.v1"),
        event_id: z.string().uuid(),
        idempotency_key: z.string().uuid(),
        request_id: z.string().min(1),
        client_id: z.string().min(1),
        version: z.number().int().min(1),
        occurred_at: iso,
        signature: z
            .object({ state: z.enum(SIGNATURE_STATES), at: nullableIso })
            .strict(),
        payment: z
            .object({
                state: z.enum(PAYMENT_STATES),
                method: z.enum(PAYMENT_METHODS).nullable(),
                last4: z
                    .string()
                    .regex(/^\d{4}$/)
                    .nullable(),
                at: nullableIso,
            })
            .strict(),
        provisioning: z
            .object({
                state: z.enum(PROVISIONING_STATES),
                kelevo_ref: z.string().nullable(),
                at: nullableIso,
            })
            .strict(),
        operations: z
            .object({
                state: z.enum(["PENDING", "COMPLETE"]),
                items: z.array(
                    z
                        .object({
                            key: z.enum(OPERATION_KEYS),
                            state: z.enum(["PENDING", "VERIFIED"]),
                            at: nullableIso,
                        })
                        .strict()
                ),
            })
            .strict(),
        readiness: z.enum(["IN_PROGRESS", "BLOCKED", "READY", "CLOSED"]),
        blocked: z
            .object({
                code: z.string().min(1),
                action: z.enum(ACTIONS).nullable(),
            })
            .strict()
            .nullable(),
        documents: z.object({ signed_available: z.boolean() }).strict(),
    })
    .strict();

// iwd-backend never receives jack.call.v1; the mirror only keeps the shared
// fixture honest on this side as well.
export const jackCallV1 = z.object({
    contract: z.literal("jack.call.v1"),
    event_id: z.string().uuid(),
    occurred_at: iso,
    record: z.object({
        id: z.string().min(1),
        revision: z.number().int().min(1),
    }),
    call: z
        .object({
            started_at: iso,
            ended_at: nullableIso,
            outcome: z.string(),
            summary_status: z.enum(["PENDING", "READY", "UNAVAILABLE"]),
        })
        .passthrough(),
    source_link: z.string().url(),
});

export const actorSchema = z
    .object({
        user_id: z.string().min(1).max(100),
        email: z.string().email().max(254),
    })
    .strict();
