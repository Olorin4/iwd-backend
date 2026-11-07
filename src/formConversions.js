// Shared by the website form controllers (sign-up, contact, newsletter).
import { recordConversion } from "./conversions.js";

const NO_ATTRIBUTION = { outreachRef: null, posthogDistinctId: null };

// Set by the attributionFields middleware; absent only when a handler is
// called without it (e.g. directly in tests).
function attributionOf(res) {
    return {
        identityEmail: res.locals?.identityEmail ?? null,
        attribution: res.locals?.attribution ?? NO_ATTRIBUTION,
    };
}

/**
 * Record the conversion after the visitor has been answered. Not awaited, and
 * any failure (recordConversion should never reject) is only logged, so
 * analytics can never fail or slow down a form.
 */
function recordAfterResponse(conversion) {
    try {
        void recordConversion(conversion).catch((error) =>
            console.error("❌ Conversion Error:", error?.message)
        );
    } catch (error) {
        console.error("❌ Conversion Error:", error?.message);
    }
}

export { attributionOf, recordAfterResponse };
