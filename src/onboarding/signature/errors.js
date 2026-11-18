export class SignatureError extends Error {
    /** ambiguous: the provider may have accepted the call (timeout, network, 5xx). */
    constructor(code, { ambiguous = false, status = null } = {}) {
        super(code);
        this.name = "SignatureError";
        this.code = code;
        this.ambiguous = ambiguous;
        this.status = status;
    }
}

/** Provider document status → envelope state. Unknown values map to null. */
export function normalizeProviderStatus(status) {
    const s = String(status ?? "")
        .toLowerCase()
        .replace(/[\s-]+/g, "_");
    if (s === "draft") return "DRAFT";
    if (["pending", "sent", "awaiting_signature", "in_progress"].includes(s))
        return "SENT";
    if (s === "viewed") return "VIEWED";
    if (s === "completed") return "COMPLETED";
    if (s === "declined") return "DECLINED";
    if (s === "expired") return "EXPIRED";
    if (["canceled", "cancelled", "voided"].includes(s)) return "CANCELLED";
    if (s === "error" || s === "failed") return "ERROR";
    return null;
}
