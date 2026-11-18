// Plain, readable transactional email text (no JSON, no internal ids). The
// shared emailService adds the business signature.
const METHOD_LABELS = {
    card: "a card",
    us_bank_account: "a US bank account (ACH)",
};

export function paymentLinkEmail({ terms, url }) {
    const methods = terms.payment_methods
        .map((m) => METHOD_LABELS[m])
        .join(" or ");
    return {
        subject: "Next step: save your payment method for Iron Wing",
        text: [
            `Hello ${terms.signer.name},`,
            `Thank you for signing the Iron Wing dispatch service agreement for ${terms.legal_name}.`,
            `The next step is to save ${methods} on Stripe's secure page:\n${url}`,
            "Saving the payment method does not charge you. Fees are charged only as described in your signed agreement and payment authorization.",
            "Stripe collects the card or bank details. We will never ask for card or bank account numbers by email or phone.",
            // The shared email signature (src/assets/signature.js) signs with the
            // legal name, Iron Wing Logistics L.L.C.; no second sign-off here.
            "If the link no longer works, reply to this email and we will send a new one.",
        ].join("\n\n"),
    };
}
