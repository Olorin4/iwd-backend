const normalize = (value) =>
    String(value ?? "")
        .toUpperCase()
        .normalize("NFKC");
const name = (value) =>
    normalize(value)
        .replace(/\./g, "")
        .replace(/[^A-Z0-9 ]/g, " ")
        .trim()
        .replace(/(?:\s+(?:LLC|INC|CORP|CO))+$/, "")
        .replace(/\s+/g, "");
const number = (value) =>
    normalize(value)
        .replace(/\D/g, "")
        .replace(/^0+(?=\d)/, "");
const different = (first, second, transform) => {
    const left = transform(first);
    const right = transform(second);
    return Boolean(left && right && left !== right);
};
const readableFields = {
    W9: ["legal_name", "business_name", "tin_last4", "address"],
    INSURANCE_COI: [
        "named_insured",
        "certificate_holder",
        "insurers",
        "policies",
    ],
    AUTHORITY_VERIFIED: ["legal_name", "mc_number", "usdot", "authority_type"],
    FACTORING_NOA: [
        "carrier_name",
        "factoring_company",
        "remittance_address",
        "contact_email",
    ],
};

export function computeFlags(itemKey, extracted, terms, today) {
    if (!extracted) return ["unreadable"];
    const flags = [];
    if (extracted.document_type_matches === false)
        flags.push("wrong_document_type");
    const carrier =
        extracted.legal_name ??
        extracted.named_insured ??
        extracted.carrier_name;
    if (different(carrier, terms.legal_name, name)) flags.push("name_mismatch");
    if (different(extracted.mc_number, terms.mc_number, number))
        flags.push("mc_mismatch");
    if (different(extracted.usdot, terms.usdot, number))
        flags.push("usdot_mismatch");
    if (itemKey === "INSURANCE_COI") {
        const day = Date.parse(new Date(today).toISOString().slice(0, 10));
        const days = extracted.policies.map(({ expiry_date }) =>
            expiry_date ? (Date.parse(expiry_date) - day) / 86400000 : NaN
        );
        if (days.some((value) => value < 0)) flags.push("insurance_expired");
        if (days.some((value) => value >= 0 && value <= 30))
            flags.push("insurance_expiring_30d");
    }
    if (itemKey === "W9" && extracted.signature_present === false)
        flags.push("signature_missing");
    if (
        !(readableFields[itemKey] ?? []).some((key) =>
            Array.isArray(extracted[key])
                ? extracted[key].length > 0
                : Boolean(extracted[key])
        )
    )
        flags.push("unreadable");
    return flags;
}
