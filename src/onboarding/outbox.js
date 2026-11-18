import { signBody } from "./signing.js";
import { STATUS_EVENT } from "./store.js";

// Status outbox → Outreach POST /internal/sales/onboarding-status with
// bearer ONBOARDING_STATUS_TOKEN and X-IW-Signature (ONBOARDING_STATUS_SIGNING_SECRET).
// Outreach applies an event only when its version is newer, so retries and
// out-of-order delivery are safe.
export const MAX_ATTEMPTS = 20;
export const backoffMs = (attempts) =>
    Math.min(30000 * 2 ** Math.max(0, attempts - 1), 3600000);
const PERMANENT = (status) =>
    status >= 400 && status < 500 && status !== 408 && status !== 429;

export async function deliverPending(
    deps,
    { fetch: fetchImpl = globalThis.fetch, limit = 50 } = {}
) {
    const { db, config } = deps;
    if (!config.enabled || !config.outbox?.enabled)
        return { delivered: 0, failed: 0 };
    const now = deps.now();
    const events = await db.onboardingEvent.findMany({
        where: {
            type: STATUS_EVENT,
            delivered_at: null,
            next_attempt_at: { lte: now },
        },
        orderBy: { created_at: "asc" },
        take: limit,
    });
    let delivered = 0,
        failed = 0;
    for (const event of events) {
        const body = JSON.stringify(event.payload);
        let status = null;
        try {
            const response = await fetchImpl(config.outbox.url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${config.outbox.token}`,
                    "X-IW-Signature": signBody(
                        config.outbox.signingSecret,
                        body,
                        Math.floor(now.getTime() / 1000)
                    ),
                },
                body,
                signal: AbortSignal.timeout(10000),
            });
            status = response.status;
        } catch {
            status = null;
        }
        if (status !== null && status >= 200 && status < 300) {
            await db.onboardingEvent.update({
                where: { id: event.id },
                data: {
                    delivered_at: now,
                    attempts: { increment: 1 },
                    last_error_code: null,
                },
            });
            delivered += 1;
            continue;
        }
        failed += 1;
        const attempts = event.attempts + 1;
        const dead =
            (status !== null && PERMANENT(status)) || attempts >= MAX_ATTEMPTS;
        await db.onboardingEvent.update({
            where: { id: event.id },
            data: {
                attempts,
                last_error_code:
                    status === null ? "network_error" : `http_${status}`,
                next_attempt_at: dead
                    ? null
                    : new Date(now.getTime() + backoffMs(attempts)),
            },
        });
        deps.logger?.warn?.({
            code: dead
                ? "onboarding_status_undeliverable"
                : "onboarding_status_retry",
            status,
        });
    }
    return { delivered, failed };
}
