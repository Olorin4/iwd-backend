import {
    deriveWaitingFor,
    findRecipient,
    recipientSigned,
} from "../../src/onboarding/signature/waitingFor";

const r = (iw, carrier) => [
    { id: "2", status: iw },
    { id: "1", status: carrier },
];

describe("recipientSigned", () => {
    it.each([
        ["completed", true],
        ["Completed", true],
        ["signed", true],
        ["created", false],
        ["draft", false],
        ["sent", false],
        ["Sent", false],
        ["pending", false],
        ["viewed", false],
        ["awaiting signature", false],
        ["in-progress", false],
        ["declined", null],
        ["bounced", null],
        ["something_new", null],
        ["", null],
        [null, null],
        [undefined, null],
        [7, null],
    ])("%p → %p", (status, expected) => {
        expect(recipientSigned(status)).toBe(expected);
    });
});

describe("deriveWaitingFor", () => {
    it.each(["SENT", "VIEWED"])("%s: Iron Wing unsigned → IRON_WING", (s) => {
        expect(deriveWaitingFor(s, r("sent", "sent"))).toBe("IRON_WING");
        expect(deriveWaitingFor(s, r("created", "created"))).toBe("IRON_WING");
        expect(deriveWaitingFor(s, r("viewed", "sent"))).toBe("IRON_WING");
    });

    it.each(["SENT", "VIEWED"])("%s: Iron Wing signed → CARRIER", (s) => {
        expect(deriveWaitingFor(s, r("completed", "sent"))).toBe("CARRIER");
        expect(deriveWaitingFor(s, r("signed", "viewed"))).toBe("CARRIER");
    });

    it("both signed but not yet completed → null", () => {
        expect(deriveWaitingFor("SENT", r("completed", "completed"))).toBe(
            null
        );
    });

    it("carrier signed before Iron Wing contradicts the order → null", () => {
        expect(deriveWaitingFor("SENT", r("sent", "completed"))).toBe(null);
    });

    it("unknown statuses → null", () => {
        expect(deriveWaitingFor("SENT", r("mystery", "sent"))).toBe(null);
        expect(deriveWaitingFor("SENT", r("sent", "mystery"))).toBe(null);
        expect(deriveWaitingFor("SENT", r(null, "sent"))).toBe(null);
        expect(deriveWaitingFor("SENT", r("completed", "bounced"))).toBe(null);
    });

    it.each([
        "NOT_SENT",
        "SENDING",
        "UNKNOWN",
        "COMPLETED",
        "DECLINED",
        "EXPIRED",
        "CANCELLED",
        "ERROR",
        null,
        undefined,
    ])("signature state %p → null", (s) => {
        expect(deriveWaitingFor(s, r("sent", "sent"))).toBe(null);
    });

    it("missing, malformed or duplicate recipients → null", () => {
        expect(deriveWaitingFor("SENT", undefined)).toBe(null);
        expect(deriveWaitingFor("SENT", null)).toBe(null);
        expect(deriveWaitingFor("SENT", "x")).toBe(null);
        expect(deriveWaitingFor("SENT", [])).toBe(null);
        expect(deriveWaitingFor("SENT", [{ id: "2", status: "sent" }])).toBe(
            null
        );
        expect(deriveWaitingFor("SENT", [null, { id: "1" }])).toBe(null);
        expect(
            deriveWaitingFor("SENT", [
                { id: "2", status: "sent" },
                { id: "2", status: "sent" },
                { id: "1", status: "sent" },
            ])
        ).toBe(null);
    });

    it("provider-generated ids fall back to signing order", () => {
        const recipients = [
            { id: "uuid-b", status: "sent", signing_order: 2 },
            { id: "uuid-a", status: "completed", signing_order: 1 },
        ];
        expect(findRecipient(recipients, "IRON_WING").id).toBe("uuid-a");
        expect(deriveWaitingFor("SENT", recipients)).toBe("CARRIER");
        // Mixed: one of our ids present → no signing-order fallback.
        expect(
            deriveWaitingFor("SENT", [
                { id: "2", status: "sent", signing_order: 1 },
                { id: "uuid", status: "sent", signing_order: 2 },
            ])
        ).toBe(null);
        expect(findRecipient(recipients, "OTHER")).toBe(null);
    });
});

it("derives IRON_WING from the statuses SignWell actually returned in the sandbox (2026-11-18)", () => {
    expect(
        deriveWaitingFor("SENT", [
            { id: "2", status: "sent", signing_order: 1 },
            { id: "1", status: "waiting", signing_order: 2 },
        ])
    ).toBe("IRON_WING");
});
