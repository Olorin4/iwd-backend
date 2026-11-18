import { prisma } from "../../src/prismaClient";
import {
    SIGNING,
    TOKEN,
    cleanTables,
    fixture,
    requestBody,
    serializeSuite,
    startApp,
} from "./harness";
import { signBody } from "../../src/onboarding/signing";
import { recordReceipt } from "../../src/onboarding/store";
import { signedHeaders } from "./harness";
import { onboardingStatusV1 } from "../../src/onboarding/contracts";

serializeSuite();

let app, deps, config;
const KEY = fixture("onboarding.request.v1").idempotency_key;

beforeEach(async () => {
    await cleanTables(prisma);
    config = {
        enabled: true,
        serviceToken: TOKEN,
        requestSigningSecret: SIGNING,
    };
    deps = {
        db: prisma,
        now: () => new Date(),
        schedule: jest.fn(),
        onRequestCreated: jest.fn(),
        recordReceipt: jest.fn().mockResolvedValue(true),
        logger: { error: jest.fn(), info: jest.fn() },
    };
    app = await startApp(
        () => config,
        () => deps
    );
});
afterEach(() => app.close());
afterAll(() => cleanTables(prisma));

it("returns 404 for every route when the module is disabled", async () => {
    config = { enabled: false };
    expect(
        (await app.call("PUT", `/requests/${KEY}`, requestBody())).status
    ).toBe(404);
    expect((await app.call("GET", `/requests/${KEY}`)).status).toBe(404);
});

it("rejects a missing bearer, a bad signature and a stale timestamp", async () => {
    const body = requestBody();
    expect(
        (await app.call("PUT", `/requests/${KEY}`, body, { auth: false }))
            .status
    ).toBe(401);
    const bad = await app.call("PUT", `/requests/${KEY}`, body, {
        auth: false,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            ...signedHeaders({
                secret: "wrong".repeat(10),
                method: "PUT",
                pathAndQuery: `/onboarding/requests/${KEY}`,
                raw: JSON.stringify(body),
                t: Math.floor(Date.now() / 1000),
                body,
            }),
        },
    });
    expect(bad.json).toEqual({ error: "signature_invalid" });
    const stale = await app.call("PUT", `/requests/${KEY}`, body, {
        nowSeconds: Math.floor(Date.now() / 1000) - 301,
    });
    expect(stale.json).toEqual({ error: "signature_expired" });
    expect(await prisma.onboardingRequest.count()).toBe(0);
});

it("rejects the fixture's placeholder terms_hash and accepts the canonical hash", async () => {
    const raw = fixture("onboarding.request.v1");
    const rejected = await app.call("PUT", `/requests/${KEY}`, raw);
    expect(rejected.status).toBe(422);
    expect(rejected.json.error).toBe("terms_hash_mismatch");

    const created = await app.call("PUT", `/requests/${KEY}`, requestBody());
    expect(created.status).toBe(201);
    expect(onboardingStatusV1.parse(created.json)).toBeTruthy();
    expect(created.json).toMatchObject({
        idempotency_key: KEY,
        version: 1,
        signature: { state: "NOT_SENT" },
        payment: { state: "NOT_STARTED" },
        provisioning: { state: "NOT_STARTED" },
        operations: { state: "PENDING" },
        readiness: "IN_PROGRESS",
        blocked: null,
        documents: { signed_available: false },
    });
    expect(deps.schedule).toHaveBeenCalledTimes(1);
    const event = await prisma.onboardingEvent.findFirst();
    expect(event).toMatchObject({ type: "onboarding.status.v1", version: 1 });
});

it("is idempotent: 200 for the same key and hash, 409 for different terms, 422 invalid", async () => {
    expect(
        (await app.call("PUT", `/requests/${KEY}`, requestBody())).status
    ).toBe(201);
    const again = await app.call("PUT", `/requests/${KEY}`, requestBody());
    expect(again.status).toBe(200);
    expect(again.json.version).toBe(1);
    const changed = await app.call(
        "PUT",
        `/requests/${KEY}`,
        requestBody({}, { fee_bp: 500, plan: "ESSENTIAL" })
    );
    expect(changed.status).toBe(409);
    expect(changed.json.error).toBe("terms_mismatch");
    const invalid = await app.call(
        "PUT",
        `/requests/${KEY}`,
        requestBody({}, { fee_bp: 700 })
    );
    expect(invalid.status).toBe(422);
    expect(invalid.json.error).toBe("invalid_request");
    const wrongKey = await app.call(
        "PUT",
        `/requests/0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5c`,
        requestBody()
    );
    expect(wrongKey.json.error).toBe("idempotency_key_mismatch");
    expect(deps.schedule).toHaveBeenCalledTimes(1);
    expect(await prisma.onboardingRequest.count()).toBe(1);
});

it("concurrent identical PUTs converge on one request and one Client", async () => {
    const body = requestBody();
    const results = await Promise.all(
        Array.from({ length: 8 }, () =>
            app.call("PUT", `/requests/${KEY}`, body)
        )
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.json.request_id)).size).toBe(1);
    expect(await prisma.onboardingRequest.count()).toBe(1);
    expect(await prisma.client.count()).toBe(1);
    expect(deps.schedule).toHaveBeenCalledTimes(1);
});

it("matches an existing Client by USDOT across different requests (concurrently too)", async () => {
    const keys = [
        "aaaaaaaa-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        "bbbbbbbb-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
        "cccccccc-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
    ];
    const results = await Promise.all(
        keys.map((key) =>
            app.call(
                "PUT",
                `/requests/${key}`,
                requestBody({ idempotency_key: key })
            )
        )
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(new Set(results.map((r) => r.json.client_id)).size).toBe(1);
    expect(await prisma.client.count()).toBe(1);
    const other = await app.call(
        "PUT",
        `/requests/dddddddd-1c2d-4e3f-8a9b-0c1d2e3f4a5b`,
        requestBody(
            { idempotency_key: "dddddddd-1c2d-4e3f-8a9b-0c1d2e3f4a5b" },
            { usdot: "7654321" }
        )
    );
    expect(other.json.client_id).not.toBe(results[0].json.client_id);
});

it("GET returns onboarding.status.v1 or 404", async () => {
    expect((await app.call("GET", `/requests/${KEY}`)).status).toBe(404);
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    const got = await app.call("GET", `/requests/${KEY}`);
    expect(got.status).toBe(200);
    expect(onboardingStatusV1.parse(got.json).version).toBe(1);
});

it("refuses to change confirmed terms at the database level", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await expect(
        prisma.onboardingRequest.update({
            where: { idempotency_key: KEY },
            data: { terms: { changed: true } },
        })
    ).rejects.toThrow();
});

describe("signature v2 on the Outreach link", () => {
    const now = () => Math.floor(Date.now() / 1000);

    it("same second, different nonces: both accepted; same nonce: replay", async () => {
        deps.recordReceipt = (provider, key) =>
            recordReceipt(prisma, provider, key);
        await app.call("PUT", `/requests/${KEY}`, requestBody());
        const t = now();
        const get = (nonce) =>
            app.call("GET", `/requests/${KEY}`, undefined, {
                nowSeconds: t,
                nonce,
            });
        expect((await get("a".repeat(32))).status).toBe(200);
        expect((await get("b".repeat(32))).status).toBe(200);
        expect(await get("a".repeat(32))).toMatchObject({
            status: 401,
            json: { error: "replayed_signature" },
        });
    });

    it("requires a well-formed nonce that is bound by the signature", async () => {
        const signed = signedHeaders({
            method: "GET",
            pathAndQuery: `/onboarding/requests/${KEY}`,
            t: now(),
            nonce: "c".repeat(32),
        });
        const missing = { ...signed };
        delete missing["X-IW-Nonce"];
        expect(
            (
                await app.call("GET", `/requests/${KEY}`, undefined, {
                    auth: false,
                    headers: missing,
                })
            ).json
        ).toEqual({ error: "nonce_invalid" });
        expect(
            (
                await app.call("GET", `/requests/${KEY}`, undefined, {
                    auth: false,
                    headers: { ...signed, "X-IW-Nonce": "C".repeat(32) },
                })
            ).json
        ).toEqual({ error: "nonce_invalid" });
        expect(
            (
                await app.call("GET", `/requests/${KEY}`, undefined, {
                    auth: false,
                    headers: { ...signed, "X-IW-Nonce": "d".repeat(32) },
                })
            ).json
        ).toEqual({ error: "signature_invalid" });
    });

    it("refuses a v1 signature", async () => {
        const body = requestBody();
        const raw = JSON.stringify(body);
        const res = await app.call("PUT", `/requests/${KEY}`, body, {
            auth: false,
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "X-IW-Actor-Id": body.actor.user_id,
                "X-IW-Actor-Email": body.actor.email,
                "X-IW-Signature": signBody(SIGNING, raw, now()),
            },
        });
        expect(res).toMatchObject({
            status: 401,
            json: { error: "signature_v1_rejected" },
        });
        expect(await prisma.onboardingRequest.count()).toBe(0);
    });

    it("binds method, path, actor headers and body", async () => {
        const body = requestBody();
        const raw = JSON.stringify(body);
        const t = now();
        const good = signedHeaders({
            method: "PUT",
            pathAndQuery: `/onboarding/requests/${KEY}`,
            raw,
            t,
            body,
        });
        // Same signature presented on another path / with another actor.
        const otherPath = await app.call("PUT", `/requests/${KEY}?x=1`, body, {
            auth: false,
            headers: good,
        });
        expect(otherPath.json).toEqual({ error: "signature_invalid" });
        const otherActor = await app.call("PUT", `/requests/${KEY}`, body, {
            auth: false,
            headers: { ...good, "X-IW-Actor-Email": "intruder@example.test" },
        });
        expect(otherActor.json).toEqual({ error: "signature_invalid" });
        const otherMethod = await app.call(
            "GET",
            `/requests/${KEY}`,
            undefined,
            {
                auth: false,
                headers: good,
            }
        );
        expect(otherMethod.json).toEqual({ error: "signature_invalid" });
        expect(await prisma.onboardingRequest.count()).toBe(0);
    });

    it("refuses a body actor that differs from the signed actor headers", async () => {
        const body = requestBody();
        const raw = JSON.stringify(body);
        const signed = signedHeaders({
            method: "PUT",
            pathAndQuery: `/onboarding/requests/${KEY}`,
            raw,
            t: now(),
            headers: {
                "X-IW-Actor-Id": "66666666-6666-4666-8666-666666666666",
                "X-IW-Actor-Email": body.actor.email,
            },
        });
        const res = await app.call("PUT", `/requests/${KEY}`, body, {
            auth: false,
            headers: signed,
        });
        expect(res).toMatchObject({
            status: 401,
            json: { error: "actor_mismatch" },
        });
        // A body actor with no actor headers at all is refused too.
        const bare = signedHeaders({
            method: "PUT",
            pathAndQuery: `/onboarding/requests/${KEY}`,
            raw,
            t: now() - 1,
        });
        delete bare["X-IW-Actor-Id"];
        delete bare["X-IW-Actor-Email"];
        const none = await app.call("PUT", `/requests/${KEY}`, body, {
            auth: false,
            headers: {
                Authorization: bare.Authorization,
                "X-IW-Nonce": bare["X-IW-Nonce"],
                "X-IW-Signature": bare["X-IW-Signature"],
            },
        });
        expect(none.json).toEqual({ error: "actor_mismatch" });
        expect(await prisma.onboardingRequest.count()).toBe(0);
    });

    it("accepts an actor email that differs only in case", async () => {
        const body = requestBody();
        body.actor = { ...body.actor, email: body.actor.email.toUpperCase() };
        const res = await app.call("PUT", `/requests/${KEY}`, body, {
            headers: { "X-IW-Actor-Email": body.actor.email.toLowerCase() },
        });
        expect(res.status).toBe(201);
    });

    const N1 = "0".repeat(31) + "1";
    const N2 = "0".repeat(31) + "2";

    it("refuses a replayed signature on GET and PUT", async () => {
        deps.recordReceipt = (provider, key) =>
            recordReceipt(prisma, provider, key);
        const body = requestBody();
        const t = now() - 3;
        expect(
            (
                await app.call("PUT", `/requests/${KEY}`, body, {
                    nowSeconds: t,
                    nonce: N1,
                })
            ).status
        ).toBe(201);
        expect(
            await app.call("PUT", `/requests/${KEY}`, body, {
                nowSeconds: t,
                nonce: N1,
            })
        ).toMatchObject({ status: 401, json: { error: "replayed_signature" } });
        const g = now() - 4;
        expect(
            (
                await app.call("GET", `/requests/${KEY}`, undefined, {
                    nowSeconds: g,
                    nonce: N2,
                })
            ).status
        ).toBe(200);
        expect(
            await app.call("GET", `/requests/${KEY}`, undefined, {
                nowSeconds: g,
                nonce: N2,
            })
        ).toMatchObject({ status: 401, json: { error: "replayed_signature" } });
        const receipts = await prisma.providerWebhookReceipt.findMany({
            where: { provider: "outreach" },
        });
        expect(receipts).toHaveLength(2);
        expect(
            receipts.every((r) =>
                /^outreach:v2:[0-9a-f]{64}$/.test(r.receipt_key)
            )
        ).toBe(true);
    });
});
