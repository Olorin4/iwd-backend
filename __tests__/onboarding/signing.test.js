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
