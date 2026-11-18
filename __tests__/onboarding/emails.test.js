import {
    agreementFilename,
    completionEmail,
    refOf,
    reminderEmail,
} from "../../src/onboarding/emails";

const terms = {
    legal_name: "Example Freight LLC",
    mc_number: "MC123456",
    signer: { name: "Sam Example" },
};
const ID = "31700238-a37e-4ab8-ac1a-b977a2ae60c9";

describe("R15 completion email", () => {
    it("uses the owner-approved subject and text verbatim", () => {
        const { subject, text } = completionEmail({
            terms,
            requestId: ID,
            url: "https://x.test/c/t",
        });
        expect(subject).toBe(
            "Your signed Iron Wing agreement and next steps — Example Freight LLC (ref 31700238)"
        );
        expect(text).toBe(
            "Hello Sam Example,\n\n" +
                "Thank you. Your dispatch service agreement, limited power of attorney and payment authorization are now signed by both parties. Your signed copy is attached to this email.\n\n" +
                "Payment method: if you haven't finished saving it yet, use Stripe's secure page here:\nhttps://x.test/c/t\nNothing is charged when you save it. Never send card or bank account numbers by email.\n\n" +
                "Documents we need before we start dispatching for Example Freight LLC. Please reply to this email with:\n" +
                "1. A signed W-9 form\n" +
                "2. Your certificate of insurance\n" +
                "3. A copy of your operating authority (MC 123456)\n" +
                "4. Your factoring company's notice of assignment, or reply \"no factoring\" if you don't use one\n" +
                "5. Your carrier profile: equipment, preferred lanes, minimum rates, any freight you won't haul and any other preferences you have (a short list in the email is fine)"
        );
        expect(`${subject}${text}`).not.toMatch(/[{}]/);
    });

    it("names the MC number without a duplicated prefix, and none when absent", () => {
        const plain = completionEmail({
            terms: { ...terms, mc_number: "987" },
            requestId: ID,
            url: "u",
        }).text;
        expect(plain).toContain(
            "3. A copy of your operating authority (MC 987)\n"
        );
        const none = completionEmail({
            terms: { ...terms, mc_number: null },
            requestId: ID,
            url: "u",
        }).text;
        expect(none).toContain("3. A copy of your operating authority\n");
        expect(none).not.toMatch(/null|MC/);
    });

    it("builds the attachment filename from the legal name", () => {
        expect(agreementFilename("Example Freight LLC")).toBe(
            "Iron-Wing-agreement-example-freight-llc.pdf"
        );
        expect(agreementFilename("Café & Sons, Inc.")).toBe(
            "Iron-Wing-agreement-cafe-sons-inc.pdf"
        );
        expect(agreementFilename("***")).toBe(
            "Iron-Wing-agreement-carrier.pdf"
        );
        expect(agreementFilename("x".repeat(300))).toBe(
            `Iron-Wing-agreement-${"x".repeat(80)}.pdf`
        );
    });

    it("ref is the first 8 characters of the request id", () => {
        expect(refOf(ID)).toBe("31700238");
    });
});

describe("R15 reminder email", () => {
    const subject =
        "Reminder: still needed for your Iron Wing onboarding — Example Freight LLC (ref 31700238)";
    const ending =
        "\n\nPlease reply to this email. If you have questions or need more time, just let us know.";

    it("lists only the missing documents, renumbered, plus the payment line", () => {
        const mail = reminderEmail({
            terms,
            requestId: ID,
            missingSlots: ["INSURANCE_COI", "FACTORING"],
            paymentUrl: "https://x.test/c/t",
        });
        expect(mail.subject).toBe(subject);
        expect(mail.text).toBe(
            "Hello Sam Example,\n\n" +
                "We're still missing the following for Example Freight LLC:\n" +
                "1. Your certificate of insurance\n" +
                "2. Your factoring company's notice of assignment, or reply \"no factoring\" if you don't use one\n" +
                "Your payment method: save it on Stripe's secure page here:\nhttps://x.test/c/t" +
                ending
        );
        expect(mail.text).not.toMatch(/[{}]/);
    });

    it("omits the payment line once the payment method is saved", () => {
        const { text } = reminderEmail({
            terms,
            requestId: ID,
            missingSlots: ["AUTHORITY_VERIFIED"],
            paymentUrl: null,
        });
        expect(text).toBe(
            "Hello Sam Example,\n\n" +
                "We're still missing the following for Example Freight LLC:\n" +
                "1. A copy of your operating authority (MC 123456)" +
                ending
        );
    });

    it("renumbers the carrier profile item and keeps its text verbatim", () => {
        const { text } = reminderEmail({
            terms,
            requestId: ID,
            missingSlots: ["W9", "CARRIER_PROFILE"],
            paymentUrl: null,
        });
        expect(text).toBe(
            "Hello Sam Example,\n\n" +
                "We're still missing the following for Example Freight LLC:\n" +
                "1. A signed W-9 form\n" +
                "2. Your carrier profile: equipment, preferred lanes, minimum rates, any freight you won't haul and any other preferences you have (a short list in the email is fine)" +
                ending
        );
    });

    it("can be only the payment line", () => {
        const { text } = reminderEmail({
            terms,
            requestId: ID,
            missingSlots: [],
            paymentUrl: "https://x.test/c/t",
        });
        expect(text).toBe(
            "Hello Sam Example,\n\n" +
                "We're still missing the following for Example Freight LLC:\n" +
                "Your payment method: save it on Stripe's secure page here:\nhttps://x.test/c/t" +
                ending
        );
    });
});
