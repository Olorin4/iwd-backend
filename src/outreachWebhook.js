import crypto from "crypto";
import { logger } from "./logging.js";

const MAX_ATTEMPTS = 3;
// Waits between attempts: before the 2nd and before the 3rd.
const RETRY_DELAYS_MS = [1000, 5000];
const ATTEMPT_TIMEOUT_MS = 10000;

const isNonEmpty = (v) => typeof v === "string" && v.length > 0;

// Release the connection of a response whose body we will not read. Never
// throws: a failing cancel must not change the outcome.
function discardBody(response) {
    try {
        response?.body?.cancel?.()?.catch?.(() => {});
    } catch {
        // ignore
    }
}

/**
 * Tell Outreach that a website form was submitted so it can stop or pause that
 * carrier's follow-up emails. Resolves to "sent", "skipped", "rejected" (final
 * 4xx) or "failed" (all attempts used); it never throws.
 */
async function notifyOutreach(
    { type, outreachRef, email, leadId, occurredAt },
    {
        fetchImpl = fetch,
        sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        env = process.env,
    } = {}
) {
    const url = env.OUTREACH_CONVERSION_WEBHOOK_URL;
    const token = env.OUTREACH_WEBHOOK_TOKEN;
    if (!isNonEmpty(url) || !isNonEmpty(token)) return "skipped";
    if (!isNonEmpty(outreachRef) && !isNonEmpty(email)) return "skipped";

    const eventId = crypto.randomUUID();
    const body = JSON.stringify({
        event_id: eventId,
        type,
        brand: "IRON_WING",
        outreach_ref: isNonEmpty(outreachRef) ? outreachRef : null,
        email: isNonEmpty(email) ? email : null,
        occurred_at: occurredAt ?? new Date().toISOString(),
        lead_id: leadId,
    });
    const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
    };
    // Never log the token or the email; the event id and lead id are enough.
    const logCtx = { eventId, leadId, type };

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        let reason;
        try {
            const response = await fetchImpl(url, {
                method: "POST",
                headers,
                body,
                // A redirect is not followed: fetch rejects, and the attempt
                // is retried like any other network error.
                redirect: "error",
                signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
            });
            if (response.status >= 200 && response.status < 300) return "sent";
            discardBody(response);
            if (response.status >= 400 && response.status < 500) {
                logger.warn("Outreach webhook rejected the event", {
                    ...logCtx,
                    status: response.status,
                });
                return "rejected";
            }
            reason = `status ${response.status}`;
        } catch (error) {
            reason = `${error?.name || "Error"}: ${error?.message || "unknown"}`;
        }

        if (attempt < MAX_ATTEMPTS) {
            logger.warn("Outreach webhook attempt failed, retrying", {
                ...logCtx,
                attempt,
                reason,
            });
            await sleep(RETRY_DELAYS_MS[attempt - 1]);
        } else {
            logger.error("Outreach webhook failed after all attempts", {
                ...logCtx,
                attempts: MAX_ATTEMPTS,
                reason,
            });
        }
    }
    return "failed";
}

export { notifyOutreach };
