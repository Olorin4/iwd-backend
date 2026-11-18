import {
    bearerMatches,
    signBody,
    verifySignature,
} from "../../src/onboarding/signing";

const secret = "k".repeat(40);
it("verifies a signature over t.rawBody within 300 seconds", () => {
    const header = signBody(secret, '{"a":1}', 1000);
    expect(
        verifySignature({
            secret,
            header,
            rawBody: '{"a":1}',
            nowSeconds: 1300,
        })
    ).toBeNull();
    expect(
        verifySignature({
            secret,
            header,
            rawBody: '{"a":1}',
            nowSeconds: 1301,
        })
    ).toBe("signature_expired");
    expect(
        verifySignature({
            secret,
            header,
            rawBody: '{"a":2}',
            nowSeconds: 1000,
        })
    ).toBe("signature_invalid");
    expect(
        verifySignature({
            secret: "x".repeat(40),
            header,
            rawBody: '{"a":1}',
            nowSeconds: 1000,
        })
    ).toBe("signature_invalid");
    expect(
        verifySignature({
            secret,
            header: "garbage",
            rawBody: "",
            nowSeconds: 1000,
        })
    ).toBe("signature_missing");
    expect(
        verifySignature({
            secret,
            header: undefined,
            rawBody: "",
            nowSeconds: 1000,
        })
    ).toBe("signature_missing");
});
it("matches bearer tokens in constant time regardless of length", () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
    expect(bearerMatches(`Bearer ${secret}x`, secret)).toBe(false);
    expect(bearerMatches("Bearer short", secret)).toBe(false);
    expect(bearerMatches(secret, secret)).toBe(false);
    expect(bearerMatches(undefined, secret)).toBe(false);
});

it("compares hex strictly (no trailing junk, no uppercase)", async () => {
    const { safeEqualHex } = await import("../../src/onboarding/signing");
    expect(safeEqualHex("abcd", "abcd")).toBe(true);
    expect(safeEqualHex("abcd", "abcdx")).toBe(false);
    expect(safeEqualHex("abcd", "ABCD")).toBe(false);
    expect(safeEqualHex("", "")).toBe(false);
});

describe("request signature v2 (Outreach → iwd-backend)", () => {
    // Shared test vector: the same literal is asserted in the Outreach repo.
    const VECTOR = {
        secret: "s".repeat(32),
        input: {
            t: 1700000000,
            method: "GET",
            pathAndQuery:
                "/onboarding/requests/0b7e8f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b/documents/signed",
            actorId: "55555555-5555-4555-8555-555555555555",
            actorEmail: "closer@example.test",
            rawBody: "",
        },
        header: "t=1700000000,v2=977cc0d7d049974bfb323c24fab8a596ff19b36555e2f9f38024eff0ec8fd6b4",
    };

    it("matches the shared test vector", async () => {
        const { signRequestV2 } = await import("../../src/onboarding/signing");
        expect(signRequestV2(VECTOR.secret, VECTOR.input)).toBe(VECTOR.header);
    });

    it("verifies within ±300 s and binds every canonical field", async () => {
        const { verifyRequestV2 } = await import(
            "../../src/onboarding/signing"
        );
        const base = {
            secret: VECTOR.secret,
            header: VECTOR.header,
            ...VECTOR.input,
            nowSeconds: 1700000300,
        };
        expect(verifyRequestV2(base)).toEqual({
            v2: VECTOR.header.split("v2=")[1],
        });
        // The email is canonicalised lower-case.
        expect(
            verifyRequestV2({ ...base, actorEmail: "Closer@Example.TEST" })
                .error
        ).toBeUndefined();
        expect(verifyRequestV2({ ...base, nowSeconds: 1700000301 }).error).toBe(
            "signature_expired"
        );
        for (const change of [
            { method: "POST" },
            { pathAndQuery: `${VECTOR.input.pathAndQuery}?a=1` },
            { actorId: null },
            { actorId: "66666666-6666-4666-8666-666666666666" },
            { actorEmail: null },
            { actorEmail: "other@example.test" },
            { rawBody: "{}" },
            { secret: "x".repeat(32) },
        ])
            expect(verifyRequestV2({ ...base, ...change }).error).toBe(
                "signature_invalid"
            );
    });

    it("rejects v1 and malformed headers", async () => {
        const { verifyRequestV2 } = await import(
            "../../src/onboarding/signing"
        );
        const base = { ...VECTOR.input, secret: VECTOR.secret };
        const v1 = signBody(VECTOR.secret, "", VECTOR.input.t);
        expect(
            verifyRequestV2({ ...base, header: v1, nowSeconds: VECTOR.input.t })
                .error
        ).toBe("signature_v1_rejected");
        for (const header of [undefined, "garbage", "t=1,v2=zz"])
            expect(
                verifyRequestV2({ ...base, header, nowSeconds: 1 }).error
            ).toBe("signature_missing");
    });
});
