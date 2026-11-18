import {
    agreementFilename,
    completionEmail,
    paymentLinkEmail,
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

describe("payment button (HTML part)", () => {
    const URL_ = "https://api.example.test/onboarding/continue/a.b.c";
    const BASE = "https://api.example.test";
    const evil = {
        ...terms,
        legal_name: `Bad <b>&"' Co`,
        signer: { name: `<img src=x onerror=1>` },
        payment_methods: ["card"],
    };
    const buttons = (html) =>
        [...html.matchAll(/<a [^>]*>Save your payment method<\/a>/g)].map(
            (m) => m[0]
        );
    const mails = (t = terms) => ({
        completion: completionEmail({
            terms: t,
            requestId: ID,
            url: URL_,
            baseUrl: BASE,
        }),
        reminderWithDocs: reminderEmail({
            terms: t,
            requestId: ID,
            missingSlots: ["W9"],
            paymentUrl: URL_,
            baseUrl: BASE,
        }),
        reminderPaymentOnly: reminderEmail({
            terms: t,
            requestId: ID,
            missingSlots: [],
            paymentUrl: URL_,
            baseUrl: BASE,
        }),
        resend: paymentLinkEmail({
            terms: { ...t, payment_methods: ["card"] },
            url: URL_,
            baseUrl: BASE,
        }),
    });

    it.each([
        "completion",
        "reminderWithDocs",
        "reminderPaymentOnly",
        "resend",
    ])("%s: exactly one button anchor pointing at the continue URL", (kind) => {
        const { html, text } = mails()[kind];
        const found = buttons(html);
        expect(found).toHaveLength(1);
        expect(found[0]).toContain(`href="${URL_}"`);
        expect(found[0]).toMatch(/style="[^"]*background-color:#0b3d91/);
        expect(html).not.toMatch(/<table/i);
        // the URL is visible only in the small fallback line
        const visible = html.replace(/<[^>]+>/g, "");
        expect(visible.split(URL_)).toHaveLength(2);
        expect(visible).toContain(`or open this link: ${URL_}`);
        // the text part keeps the link alone on its own line
        expect(text).toContain(`\n${URL_}`);
        expect(text).not.toContain("Save your payment method");
        expect(text).not.toMatch(/<[a-z]/i);
    });

    it("text parts are unchanged by the HTML part", () => {
        const m = mails();
        expect(m.reminderPaymentOnly.text).toBe(
            reminderEmail({
                terms,
                requestId: ID,
                missingSlots: [],
                paymentUrl: URL_,
            }).text
        );
        expect(m.completion.text).toContain(
            `use Stripe's secure page here:\n${URL_}\nNothing is charged`
        );
        expect(m.resend.text).toContain(
            `save a card on Stripe's secure page:\n${URL_}\n\n`
        );
    });

    it("a reminder without the payment line has no button", () => {
        const { html } = reminderEmail({
            terms,
            requestId: ID,
            missingSlots: ["W9"],
            paymentUrl: null,
            baseUrl: BASE,
        });
        expect(buttons(html)).toHaveLength(0);
        expect(html).toContain("1. A signed W-9 form");
    });

    it("escapes the legal name and signer in every HTML part", () => {
        for (const { html } of Object.values(mails(evil))) {
            expect(html).not.toContain("<b>");
            expect(html).not.toContain("<img");
            expect(html).toContain("&lt;img src=x onerror=1&gt;");
        }
        const { html } = mails(evil).completion;
        expect(html).toContain("Bad &lt;b&gt;&amp;&quot;&#39; Co");
    });

    it("never puts an unsafe URL into an href", () => {
        for (const bad of [
            "javascript:alert(1)",
            "data:text/html,x",
            "not a url",
            "http://api.example.test/x",
        ]) {
            const { html } = completionEmail({
                terms,
                requestId: ID,
                url: bad,
                baseUrl: BASE,
            });
            expect(buttons(html)).toHaveLength(0);
            expect(html).not.toContain("href=");
        }
    });

    it("allows the configured public base URL scheme (local http sandbox)", () => {
        const local = "http://localhost:3000/onboarding/continue/t";
        const { html } = completionEmail({
            terms,
            requestId: ID,
            url: local,
            baseUrl: "http://localhost:3000",
        });
        expect(buttons(html)[0]).toContain(`href="${local}"`);
    });

    it("escapes quotes in the href", () => {
        const odd = `https://x.test/a"onmouseover="x`;
        const { html } = completionEmail({
            terms,
            requestId: ID,
            url: odd,
            baseUrl: BASE,
        });
        expect(html).not.toContain('"onmouseover="');
        expect(html).toContain("&quot;onmouseover=&quot;");
    });
});
