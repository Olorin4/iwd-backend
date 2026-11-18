import {
    buildStatus,
    deriveReadiness,
    initialOperations,
    markOperationItemReceived,
    missingCarrierSlots,
    operationsState,
    verifyOperationItem,
} from "../../src/onboarding/readiness";
import {
    ACTIONS,
    PAYMENT_STATES,
    PROVISIONING_STATES,
    SIGNATURE_STATES,
    onboardingStatusV1,
} from "../../src/onboarding/contracts";

const all = [];
for (const cancelled of [false, true])
    for (const signature of SIGNATURE_STATES)
        for (const payment of PAYMENT_STATES)
            for (const provisioning of PROVISIONING_STATES)
                for (const operations of ["PENDING", "COMPLETE"])
                    for (const signatureCode of [null, "packet_create_failed"])
                        all.push({
                            cancelled,
                            signature,
                            signatureCode,
                            payment,
                            provisioning,
                            operations,
                        });

describe("deriveReadiness over every facet combination", () => {
    it(`covers ${all.length} combinations`, () =>
        expect(all.length).toBe(2 * 10 * 5 * 6 * 2 * 2));

    it("READY exactly when all four facets are complete and the request is open", () => {
        for (const f of all) {
            const ready =
                !f.cancelled &&
                f.signature === "COMPLETED" &&
                f.payment === "READY" &&
                ["SUCCEEDED", "MANUAL_CONFIRMED"].includes(f.provisioning) &&
                f.operations === "COMPLETE";
            expect(deriveReadiness(f).readiness === "READY").toBe(ready);
        }
    });

    it("CLOSED exactly when cancelled or the packet was declined/expired/cancelled", () => {
        for (const f of all) {
            const closed =
                f.cancelled ||
                ["DECLINED", "EXPIRED", "CANCELLED"].includes(f.signature);
            expect(deriveReadiness(f).readiness === "CLOSED").toBe(closed);
        }
    });

    it("BLOCKED exactly when an open request has a failed, unknown or manual facet", () => {
        for (const f of all) {
            const { readiness } = deriveReadiness(f);
            if (readiness === "CLOSED" || readiness === "READY") continue;
            const blocked =
                ["UNKNOWN", "ERROR"].includes(f.signature) ||
                (["NOT_SENT", "SENT", "VIEWED"].includes(f.signature) &&
                    !!f.signatureCode) ||
                f.payment === "FAILED" ||
                ["FAILED", "MANUAL_REQUIRED"].includes(f.provisioning);
            expect(readiness).toBe(blocked ? "BLOCKED" : "IN_PROGRESS");
        }
    });

    it("always returns a contract-valid blocked object", () => {
        for (const f of all) {
            const { readiness, blocked } = deriveReadiness(f);
            if (readiness === "BLOCKED") {
                expect(blocked.code).toMatch(/^[a-z_]+$/);
                expect(ACTIONS).toContain(blocked.action);
            } else if (readiness === "CLOSED" && !f.cancelled) {
                expect(blocked.action).toBe("reissue_packet");
            } else {
                expect(blocked).toBeNull();
            }
        }
    });
});

describe("blocking priority and recovery actions", () => {
    const base = {
        cancelled: false,
        signature: "COMPLETED",
        payment: "READY",
        provisioning: "MANUAL_CONFIRMED",
        operations: "COMPLETE",
    };
    it.each([
        [{ signature: "UNKNOWN" }, "signature_unknown", "reconcile"],
        [
            { signature: "SENT", signatureCode: "audit_page_missing" },
            "audit_page_missing",
            "reconcile",
        ],
        [
            { signature: "ERROR", signatureCode: "bundle_unavailable" },
            "bundle_unavailable",
            "reissue_packet",
        ],
        [
            { signature: "NOT_SENT", signatureCode: "packet_create_failed" },
            "packet_create_failed",
            "reconcile",
        ],
        [
            { payment: "FAILED", paymentCode: "checkout_expired" },
            "checkout_expired",
            "resend_payment_link",
        ],
        [
            { provisioning: "FAILED" },
            "provisioning_failed",
            "retry_provisioning",
        ],
        [
            {
                provisioning: "MANUAL_REQUIRED",
                provisioningCode: "kelevo_api_unavailable",
            },
            "kelevo_api_unavailable",
            "confirm_provisioning",
        ],
        [
            { signature: "UNKNOWN", payment: "FAILED" },
            "signature_unknown",
            "reconcile",
        ],
    ])("%j → %s / %s", (change, code, action) => {
        expect(deriveReadiness({ ...base, ...change })).toEqual({
            readiness: "BLOCKED",
            blocked: { code, action },
        });
    });
    it("is READY with everything complete and IN_PROGRESS while waiting", () => {
        expect(deriveReadiness(base).readiness).toBe("READY");
        expect(
            deriveReadiness({ ...base, payment: "PENDING_VERIFICATION" })
                .readiness
        ).toBe("IN_PROGRESS");
        expect(
            deriveReadiness({ ...base, operations: "PENDING" }).readiness
        ).toBe("IN_PROGRESS");
        expect(deriveReadiness({ ...base, cancelled: true })).toEqual({
            readiness: "CLOSED",
            blocked: null,
        });
    });
});

describe("operations checklist", () => {
    const at = new Date("2026-11-19T09:40:00Z");
    const actor = { user_id: "u1", email: "closer@example.test" };
    it("starts with six pending items and completes when each slot is verified", () => {
        let items = initialOperations();
        expect(items.map((i) => i.key)).toEqual([
            "AUTHORITY_VERIFIED",
            "INSURANCE_COI",
            "W9",
            "FACTORING_NOA",
            "CARRIER_PROFILE",
            "FLEET_MAPPING",
        ]);
        expect(operationsState(items)).toBe("PENDING");
        for (const key of [
            "AUTHORITY_VERIFIED",
            "INSURANCE_COI",
            "W9",
            "NOT_FACTORING",
            "CARRIER_PROFILE",
        ])
            items = verifyOperationItem(items, key, { actor, at });
        expect(operationsState(items)).toBe("PENDING");
        items = verifyOperationItem(items, "FLEET_MAPPING", {
            actor,
            at,
            note: "2 trucks",
        });
        expect(operationsState(items)).toBe("COMPLETE");
        expect(items.find((i) => i.key === "NOT_FACTORING")).toMatchObject({
            state: "VERIFIED",
        });
        expect(items.some((i) => i.key === "FACTORING_NOA")).toBe(false);
    });
    it("rejects unknown items", () => {
        expect(() =>
            verifyOperationItem(initialOperations(), "BOGUS", { actor, at })
        ).toThrow("unknown_operation_item");
    });
});

it("buildStatus produces a contract-valid onboarding.status.v1 payload", () => {
    const row = {
        id: "77777777-7777-4777-8777-777777777777",
        idempotency_key: "0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        client_id: "88888888-8888-4888-8888-888888888888",
        version: 3,
        signature_state: "COMPLETED",
        signature_at: new Date("2026-11-19T09:30:00Z"),
        payment_state: "PENDING_VERIFICATION",
        payment_method_type: "us_bank_account",
        payment_last4: "6789",
        payment_at: new Date(),
        provisioning_state: "NOT_STARTED",
        operations: initialOperations(),
    };
    const status = buildStatus(row, {
        eventId: "66666666-6666-4666-8666-666666666666",
        occurredAt: new Date(),
        signedAvailable: true,
    });
    expect(onboardingStatusV1.parse(status)).toEqual(status);
    expect(status.readiness).toBe("IN_PROGRESS");
});

describe("signature.waiting_for (R14)", () => {
    const row = (state, waiting) => ({
        id: "77777777-7777-4777-8777-777777777777",
        idempotency_key: "0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        client_id: "88888888-8888-4888-8888-888888888888",
        version: 2,
        signature_state: state,
        signature_at: new Date("2026-11-19T09:30:00Z"),
        signature_waiting_for: waiting,
        payment_state: "NOT_STARTED",
        provisioning_state: "NOT_STARTED",
        operations: initialOperations(),
    });
    const build = (r) =>
        buildStatus(r, {
            eventId: "66666666-6666-4666-8666-666666666666",
            occurredAt: new Date(),
            signedAvailable: false,
        });

    it.each([
        ["SENT", "IRON_WING", "IRON_WING"],
        ["VIEWED", "CARRIER", "CARRIER"],
        ["SENT", null, null],
        ["SENT", undefined, null],
        ["COMPLETED", "CARRIER", null],
        ["DECLINED", "IRON_WING", null],
        ["NOT_SENT", "IRON_WING", null],
    ])("%s with stored %p → %p", (state, stored, expected) => {
        const status = build(row(state, stored));
        expect(status.signature.waiting_for).toBe(expected);
        expect(onboardingStatusV1.parse(status)).toEqual(status);
    });
});

describe("R15 checklist RECEIVED", () => {
    const at = new Date("2026-11-20T10:00:00Z");
    const actor = { user_id: "u1", email: "closer@example.test" };

    it("PENDING → RECEIVED → VERIFIED, and RECEIVED never completes the checklist", () => {
        let items = initialOperations();
        items = markOperationItemReceived(items, "W9", { actor, at });
        expect(items.find((i) => i.key === "W9")).toMatchObject({
            state: "RECEIVED",
            at: at.toISOString(),
            actor,
            note: null,
        });
        for (const key of [
            "AUTHORITY_VERIFIED",
            "INSURANCE_COI",
            "FACTORING_NOA",
            "CARRIER_PROFILE",
            "FLEET_MAPPING",
        ])
            items = verifyOperationItem(items, key, { actor, at });
        expect(operationsState(items)).toBe("PENDING");
        items = verifyOperationItem(items, "W9", { actor, at });
        expect(operationsState(items)).toBe("COMPLETE");
    });

    it("never downgrades a verified slot (either factoring key)", () => {
        let items = verifyOperationItem(initialOperations(), "NOT_FACTORING", {
            actor,
            at,
        });
        expect(
            markOperationItemReceived(items, "FACTORING_NOA", { actor, at })
        ).toBeNull();
        items = markOperationItemReceived(items, "W9", { actor, at });
        expect(
            markOperationItemReceived(items, "W9", { actor, at })
        ).not.toBeNull();
    });

    it("a factoring key replaces the slot's key", () => {
        const items = markOperationItemReceived(
            initialOperations(),
            "NOT_FACTORING",
            { actor, at }
        );
        expect(items.map((i) => i.key)).toContain("NOT_FACTORING");
        expect(items.map((i) => i.key)).not.toContain("FACTORING_NOA");
        expect(items).toHaveLength(6);
    });

    it("missingCarrierSlots lists only PENDING carrier-facing slots, never FLEET_MAPPING", () => {
        let items = initialOperations();
        expect(missingCarrierSlots(items)).toEqual([
            "W9",
            "INSURANCE_COI",
            "AUTHORITY_VERIFIED",
            "FACTORING",
            "CARRIER_PROFILE",
        ]);
        items = markOperationItemReceived(items, "W9", { actor, at });
        items = verifyOperationItem(items, "NOT_FACTORING", { actor, at });
        expect(missingCarrierSlots(items)).toEqual([
            "INSURANCE_COI",
            "AUTHORITY_VERIFIED",
            "CARRIER_PROFILE",
        ]);
        expect(missingCarrierSlots(items)).not.toContain("FLEET_MAPPING");
    });

    it("buildStatus carries RECEIVED and the reminder fields (defaults when absent)", () => {
        const row = {
            id: "77777777-7777-4777-8777-777777777777",
            idempotency_key: "0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
            client_id: "88888888-8888-4888-8888-888888888888",
            version: 3,
            signature_state: "COMPLETED",
            signature_at: at,
            payment_state: "LINK_SENT",
            provisioning_state: "NOT_STARTED",
            operations: markOperationItemReceived(initialOperations(), "W9", {
                actor,
                at,
            }),
        };
        const opts = {
            eventId: "66666666-6666-4666-8666-666666666666",
            occurredAt: at,
            signedAvailable: true,
        };
        const bare = buildStatus(row, opts);
        expect(bare.operations).toMatchObject({
            state: "PENDING",
            documents_requested_at: null,
            reminders_sent: 0,
            reminders_paused: false,
        });
        expect(bare.operations.items[2]).toEqual({
            key: "W9",
            state: "RECEIVED",
            at: at.toISOString(),
        });
        expect(onboardingStatusV1.parse(bare)).toEqual(bare);
        const full = buildStatus(
            {
                ...row,
                documents_requested_at: at,
                reminders_sent: 2,
                reminders_paused: true,
            },
            opts
        );
        expect(full.operations).toMatchObject({
            documents_requested_at: at.toISOString(),
            reminders_sent: 2,
            reminders_paused: true,
        });
        expect(onboardingStatusV1.parse(full)).toEqual(full);
    });
});

it("R15: a failed completion email blocks with action reconcile", () => {
    const f = {
        cancelled: false,
        signature: "COMPLETED",
        payment: "LINK_SENT",
        provisioning: "NOT_STARTED",
        operations: "PENDING",
        completionEmailCode: "completion_email_failed",
    };
    expect(deriveReadiness(f)).toEqual({
        readiness: "BLOCKED",
        blocked: { code: "completion_email_failed", action: "reconcile" },
    });
    expect(deriveReadiness({ ...f, completionEmailCode: null }).readiness).toBe(
        "IN_PROGRESS"
    );
});
