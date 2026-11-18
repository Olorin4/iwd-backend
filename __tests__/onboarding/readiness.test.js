import {
    buildStatus,
    deriveReadiness,
    initialOperations,
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
                (f.signature === "NOT_SENT" && !!f.signatureCode) ||
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
