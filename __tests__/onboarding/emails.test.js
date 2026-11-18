import {
    agreementFilename,
    completionEmail,
    refOf,
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
                "Payment method: if you haven't finished saving it yet, use Stripe's secure page here: https://x.test/c/t. Nothing is charged when you save it. Never send card or bank account numbers by email.\n\n" +
                "Documents we need before we start dispatching for Example Freight LLC. Please reply to this email with:\n" +
                "1. A signed W-9 form\n" +
                "2. Your certificate of insurance\n" +
                "3. A copy of your operating authority (MC 123456)\n" +
                "4. Your factoring company's notice of assignment, or reply \"no factoring\" if you don't use one\n" +
                "5. Your carrier profile: equipment, preferred lanes, minimum rates and any freight you won't haul (a short list in the email is fine)"
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
