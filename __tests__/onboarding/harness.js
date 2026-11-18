// Shared harness for onboarding integration tests: an Express app with only
// the onboarding router (never src/app.js), signed request helpers and table
// cleanup. Not a test file itself.
import express from "express";
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createOnboardingRouter,
    onboardingRawBody,
} from "../../src/onboarding/routes.js";
import { signRequestV2 } from "../../src/onboarding/signing.js";
import { termsHash } from "../../src/onboarding/canonical.js";

export const TOKEN = "t".repeat(40);
export const SIGNING = "s".repeat(40);

export const fixture = (name) =>
    JSON.parse(
        fs.readFileSync(
            path.resolve(
                __dirname,
                `../../docs/contracts/fixtures/${name}.json`
            ),
            "utf8"
        )
    );

export function requestBody(overrides = {}, termsOverrides = {}) {
    const body = fixture("onboarding.request.v1");
    Object.assign(body, overrides);
    body.terms = { ...body.terms, ...termsOverrides };
    body.terms_hash = termsHash(body.terms);
    return body;
}

export const TABLES = [
    "document_access_log",
    "onboarding_event",
    "payment_setup",
    "signature_envelope",
    "onboarding_request",
    "provider_webhook_receipt",
    "client",
];

export async function cleanTables(db) {
    for (const table of TABLES)
        await db.$executeRawUnsafe(`DELETE FROM "${table}"`);
}

/**
 * Onboarding integration files share tables and jest runs files in parallel,
 * so each file holds a session advisory lock for its whole run.
 */
export function serializeSuite() {
    let client;
    beforeAll(async () => {
        client = new pg.Client({ connectionString: process.env.DB_URL });
        await client.connect();
        await client.query("SELECT pg_advisory_lock(424242)");
    }, 180000);
    afterAll(async () => {
        await client.query("SELECT pg_advisory_unlock(424242)");
        await client.end();
    });
}

/** Removes bundle rows by name prefix (approved rows need the guard off). */
export async function deleteBundles(db, prefix) {
    await db.$transaction([
        db.$executeRawUnsafe(
            `ALTER TABLE "document_bundle_version" DISABLE TRIGGER "document_bundle_version_guard"`
        ),
        db.documentBundleVersion.deleteMany({
            where: { name: { startsWith: prefix } },
        }),
        db.$executeRawUnsafe(
            `ALTER TABLE "document_bundle_version" ENABLE TRIGGER "document_bundle_version_guard"`
        ),
    ]);
}

export function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "iwd-onboarding-"));
}

/**
 * Outreach-side signing for tests (signature v2). Actor headers come from
 * `headers` or, when absent, from the body's `actor`.
 */
export function signedHeaders({
    secret = SIGNING,
    method,
    pathAndQuery,
    raw = "",
    t,
    headers = {},
    body,
}) {
    const actor =
        body && typeof body === "object" && body.actor ? body.actor : null;
    const actorId = headers["X-IW-Actor-Id"] ?? actor?.user_id ?? null;
    const actorEmail = headers["X-IW-Actor-Email"] ?? actor?.email ?? null;
    return {
        Authorization: `Bearer ${TOKEN}`,
        ...(actorId ? { "X-IW-Actor-Id": actorId } : {}),
        ...(actorEmail ? { "X-IW-Actor-Email": actorEmail } : {}),
        "X-IW-Signature": signRequestV2(secret, {
            t,
            method,
            pathAndQuery,
            actorId,
            actorEmail,
            rawBody: raw,
        }),
    };
}

// Every accepted signature is recorded, so two identical calls with one
// timestamp would be a replay; default timestamps are never reused.
const usedSeconds = new Set();
function freshSeconds() {
    const now = Math.floor(Date.now() / 1000);
    for (let t = now; t > now - 250; t -= 1)
        if (!usedSeconds.has(t)) {
            usedSeconds.add(t);
            return t;
        }
    throw new Error("harness: no unused signature timestamp left");
}

export async function startApp(getConfig, getDeps) {
    const app = express();
    app.use("/onboarding", express.json({ verify: onboardingRawBody }));
    app.use("/onboarding", createOnboardingRouter(getConfig, getDeps));
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (
        method,
        urlPath,
        body,
        { auth = true, headers = {}, nowSeconds } = {}
    ) => {
        const raw =
            body === undefined
                ? ""
                : typeof body === "string"
                  ? body
                  : JSON.stringify(body);
        const t = nowSeconds ?? freshSeconds();
        const response = await fetch(`${base}/onboarding${urlPath}`, {
            method,
            redirect: "manual",
            headers: {
                ...(raw ? { "Content-Type": "application/json" } : {}),
                ...(auth
                    ? signedHeaders({
                          method,
                          pathAndQuery: `/onboarding${urlPath}`,
                          raw,
                          t,
                          headers,
                          body,
                      })
                    : {}),
                ...headers,
            },
            ...(raw ? { body: raw } : {}),
        });
        const text = await response.text();
        let json = null;
        try {
            json = JSON.parse(text);
        } catch {
            json = null;
        }
        return {
            status: response.status,
            json,
            text,
            headers: response.headers,
        };
    };
    return {
        server,
        base,
        call,
        close: () => new Promise((r) => server.close(r)),
    };
}

export const BUNDLE = "test-onboarding-packet";
export const WEBHOOK_ID = "signwell-webhook-id-for-tests";

/** Full test configuration (fake providers; nothing reaches a network). */
export function testConfig(dir, overrides = {}) {
    return {
        enabled: true,
        serviceToken: TOKEN,
        requestSigningSecret: SIGNING,
        publicBaseUrl: "https://api.example.test",
        continueSecret: "c".repeat(40),
        continueTtlSeconds: 30 * 86400,
        documents: {
            dir: path.join(dir, "documents"),
            key: Buffer.alloc(32, 5),
        },
        bundleName: BUNDLE,
        signature: {
            provider: "fake",
            webhookId: WEBHOOK_ID,
            countersigner: {
                name: "Dispatch Lead",
                email: "dispatch@example.test",
            },
        },
        stripe: {
            secretKey: "sk_test_onboarding_fake_key",
            live: false,
            webhookSecret: "whsec_onboarding_test_secret",
            successUrl: "https://example.test/payment-saved",
            cancelUrl: "https://example.test/payment-cancelled",
        },
        provisioning: { adapter: "manual" },
        outbox: { enabled: false },
        reconcile: { enabled: false },
        email: { from: "onboarding@example.test" },
        ...overrides,
    };
}

/** A task queue standing in for setImmediate scheduling. */
export function taskQueue() {
    const tasks = [];
    const schedule = (fn) => tasks.push(fn);
    const drain = async () => {
        while (tasks.length) await tasks.shift()();
    };
    return { schedule, drain, tasks };
}

export function captureLogger() {
    const lines = [];
    const push = (level) => (entry) => lines.push({ level, ...entry });
    return {
        lines,
        error: push("error"),
        info: push("info"),
        warn: push("warn"),
    };
}

export async function approveTestBundle(db, store, { makePacket, layout }) {
    const { registerBundle, approveBundle } = await import(
        "../../src/onboarding/documents/bundles.js"
    );
    await deleteBundles(db, BUNDLE);
    const draft = await registerBundle(db, store, {
        name: BUNDLE,
        version: 1,
        pdfs: [{ name: "packet.pdf", bytes: await makePacket() }],
        layout,
    });
    return approveBundle(db, store, { id: draft.id, by: "Test Owner" });
}
