// Shared harness for onboarding integration tests: an Express app with only
// the onboarding router (never src/app.js), signed request helpers and table
// cleanup. Not a test file itself.
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    createOnboardingRouter,
    onboardingRawBody,
} from "../../src/onboarding/routes.js";
import { signBody } from "../../src/onboarding/signing.js";
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
    await db.$executeRawUnsafe(
        `DELETE FROM "document_bundle_version" WHERE "status" = 'DRAFT'`
    );
}

export function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "iwd-onboarding-"));
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
        const t = nowSeconds ?? Math.floor(Date.now() / 1000);
        const response = await fetch(`${base}/onboarding${urlPath}`, {
            method,
            redirect: "manual",
            headers: {
                ...(raw ? { "Content-Type": "application/json" } : {}),
                ...(auth
                    ? {
                          Authorization: `Bearer ${TOKEN}`,
                          "X-IW-Signature": signBody(SIGNING, raw, t),
                      }
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
