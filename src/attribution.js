// Reads the optional attribution fields the website sends with each form
// (`outreachRef`, `posthogDistinctId`) and the visitor's typed email, and
// parks them on `res.locals` for the controllers.
//
// Runs right after requireTurnstile and before the validators/sanitizers:
//  - the sanitizers rewrite `email` (strip Gmail dots and +tags), and PostHog
//    and Outreach need the address as typed, trimmed and lowercased;
//  - both attribution fields are untrusted input, so they are validated here
//    and dropped (set to null) rather than rejected. A malformed field must
//    never block a lead.
// Both fields are deleted from `req.body` so they cannot reach the validators,
// logs or database columns by accident.

export const OUTREACH_REF_PATTERN = /^[a-z2-7]{12}$/;
const MAX_DISTINCT_ID_LENGTH = 200;

function validOutreachRef(value) {
    return typeof value === "string" && OUTREACH_REF_PATTERN.test(value)
        ? value
        : null;
}

function validDistinctId(value) {
    return typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_DISTINCT_ID_LENGTH
        ? value
        : null;
}

function identityEmailFrom(value) {
    if (typeof value !== "string") return null;
    const email = value.trim().toLowerCase();
    return email === "" ? null : email;
}

export function attributionFields(req, res, next) {
    const body = req.body && typeof req.body === "object" ? req.body : {};

    res.locals.identityEmail = identityEmailFrom(body.email);
    res.locals.attribution = {
        outreachRef: validOutreachRef(body.outreachRef),
        posthogDistinctId: validDistinctId(body.posthogDistinctId),
    };

    delete body.outreachRef;
    delete body.posthogDistinctId;
    next();
}
