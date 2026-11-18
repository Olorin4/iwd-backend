import fs from "node:fs";
import path from "node:path";
import {
    jackCallV1,
    onboardingRequestV1,
    onboardingStatusV1,
} from "../../src/onboarding/contracts";
import { canonicalJson, termsHash } from "../../src/onboarding/canonical";

const dir = path.resolve(__dirname, "../../docs/contracts/fixtures");
const read = (name) =>
    JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));

it("parses the three shared fixtures with the mirrored schemas", () => {
    expect(
        onboardingRequestV1.parse(read("onboarding.request.v1")).contract
    ).toBe("onboarding.request.v1");
    expect(onboardingStatusV1.parse(read("onboarding.status.v1")).version).toBe(
        7
    );
    expect(jackCallV1.parse(read("jack.call.v1")).record.revision).toBe(2);
});

it("fixtures are byte-identical to the Outreach originals when available", () => {
    const origin =
        "/home/olorin4/web-dev/outreach-modernize/docs/contracts/fixtures";
    if (!fs.existsSync(origin)) return;
    for (const name of [
        "jack.call.v1",
        "onboarding.request.v1",
        "onboarding.status.v1",
    ])
        expect(fs.readFileSync(path.join(dir, `${name}.json`))).toEqual(
            fs.readFileSync(path.join(origin, `${name}.json`))
        );
});

it("the fixture's terms_hash is a placeholder that the receiver must recompute", () => {
    const body = read("onboarding.request.v1");
    expect(body.terms_hash).not.toBe(termsHash(body.terms));
    expect(termsHash(body.terms)).toMatch(/^[0-9a-f]{64}$/);
});

it("canonical JSON sorts keys recursively and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: "x" }, 2] })).toBe(
        '{"a":[{"c":"x","d":null},2],"b":1}'
    );
    const a = { x: { b: 2, a: 1 }, y: [3, 1] };
    const b = { y: [3, 1], x: { a: 1, b: 2 } };
    expect(termsHash(a)).toBe(termsHash(b));
    expect(termsHash({ y: [1, 3] })).not.toBe(termsHash({ y: [3, 1] }));
});

it("enforces the amended plan, fleet and payment rules", () => {
    const body = read("onboarding.request.v1");
    const ok = (terms) =>
        onboardingRequestV1.safeParse({
            ...body,
            terms: { ...body.terms, ...terms },
        }).success;
    expect(ok({})).toBe(true);
    expect(ok({ plan: "ESSENTIAL" })).toBe(false);
    expect(ok({ plan: "ESSENTIAL", fee_bp: 500 })).toBe(true);
    expect(ok({ plan: "CUSTOM" })).toBe(false);
    const fleet = {
        plan: "FLEET",
        fee_bp: 750,
        fleet_service_plan: "FULL_SERVICE",
        truck_count: 3,
    };
    expect(ok(fleet)).toBe(true);
    expect(ok({ ...fleet, truck_count: 2 })).toBe(false);
    expect(ok({ ...fleet, fleet_service_plan: null })).toBe(false);
    expect(ok({ fleet_service_plan: "ESSENTIAL" })).toBe(false);
    expect(ok({ primary_payment_method: null })).toBe(false);
    expect(ok({ primary_payment_method: "us_bank_account" })).toBe(true);
    expect(
        ok({ payment_methods: ["card"], primary_payment_method: null })
    ).toBe(true);
    expect(
        ok({ payment_methods: ["card"], primary_payment_method: "card" })
    ).toBe(false);
    expect(ok({ statement_email: "billing@example.test" })).toBe(true);
    expect(ok({ statement_email: "nope" })).toBe(false);
    expect(ok({ extra: 1 })).toBe(false);
    expect(ok({ legal_name: " Example " })).toBe(false);
    expect(ok({ effective_date: "2026-02-30" })).toBe(false);
    expect(ok({ payment_methods: ["card", "card"] })).toBe(false);
});
