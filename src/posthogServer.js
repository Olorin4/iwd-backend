import { PostHog } from "posthog-node";

const POSTHOG_HOST = "https://us.i.posthog.com";

let sharedClient = null;

// Created on first use. flushAt: 1 and flushInterval: 0 send every event at
// once instead of batching, because a low-traffic server may never fill a
// batch or reach the next flush before it is stopped.
function getClient(token) {
    if (!sharedClient) {
        sharedClient = new PostHog(token, {
            host: POSTHOG_HOST,
            flushAt: 1,
            flushInterval: 0,
        });
    }
    return sharedClient;
}

/**
 * Record one server-side event against the visitor's email. A no-op without
 * POSTHOG_PROJECT_TOKEN ("" counts as unset) or without an identity email.
 *
 * When the browser's anonymous PostHog ID is known and differs from the
 * email, an `$identify` is sent first so the website session and this server
 * event end up on one person. The caller decides what goes in `properties`.
 */
function captureConversion(
    { event, identityEmail, posthogDistinctId, outreachRef, properties },
    { client } = {}
) {
    const token = process.env.POSTHOG_PROJECT_TOKEN;
    if (!token || !identityEmail) return;

    const posthog = client ?? getClient(token);

    if (posthogDistinctId && posthogDistinctId !== identityEmail) {
        posthog.capture({
            distinctId: identityEmail,
            event: "$identify",
            properties: { $anon_distinct_id: posthogDistinctId },
        });
    }

    posthog.capture({
        distinctId: identityEmail,
        event,
        properties: {
            ...properties,
            ...(outreachRef ? { outreach_ref: outreachRef } : {}),
            $set: { email: identityEmail },
        },
    });
}

/** Flush queued events and stop the client. Safe to call when none exists. */
async function shutdownPosthog() {
    const client = sharedClient;
    sharedClient = null;
    if (client) await client.shutdown();
}

export { captureConversion, shutdownPosthog };
