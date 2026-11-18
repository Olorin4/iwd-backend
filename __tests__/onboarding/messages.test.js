import fs from "node:fs";
import path from "node:path";
import { packetMessages, plain } from "../../src/onboarding/signature/messages";

const terms = JSON.parse(
    fs.readFileSync(
        path.resolve(
            __dirname,
            "../../docs/contracts/fixtures/onboarding.request.v1.json"
        ),
        "utf8"
    )
).terms;
const requestId = "0f1e2d3c-4b5a-4968-8776-655443322110";

it("writes the carrier and countersigner copy from the confirmed terms", () => {
    const copy = packetMessages(terms, { requestId });
    expect(copy.name).toBe(
        "Iron Wing dispatch agreement — Example Freight LLC"
    );
    expect(copy.carrier.subject).toBe(
        "Iron Wing: your dispatch agreement for Example Freight LLC — please sign"
    );
    expect(copy.carrier.message).toMatch(/from Iron Wing Logistics L\.L\.C\./);
    expect(copy.carrier.message).toMatch(
        /dispatch service agreement, limited power of attorney and payment authorization/
    );
    expect(copy.carrier.message).toMatch(/Stripe's secure page/);
    expect(copy.carrier.message).toMatch(/reply to this email before signing/);
    expect(copy.dispatch.subject).toBe(
        "INTERNAL — countersign: Example Freight LLC (Full-Service, effective November 30, 2026)"
    );
    expect(copy.dispatch.message).toMatch(/^The carrier has signed\./);
    expect(copy.dispatch.message).toMatch(
        /legal name, MC\/USDOT, plan\/fee and effective date/
    );
    expect(copy.dispatch.message).toContain("MC MC123456; USDOT 1234567");
    expect(copy.dispatch.message).toContain("fee 10%");
    expect(copy.dispatch.message).toContain("Onboarding reference: 0f1e2d3c.");
    expect(copy.dispatch.message).not.toContain(requestId);
    expect(copy.carrier.message.split("\n").length).toBeLessThanOrEqual(5);
});

it("never puts JSON or braces in any text and bounds lengths", () => {
    const hostile = {
        ...terms,
        legal_name: `{"x":1} ${"Very Long Carrier Name ".repeat(20)}\n\tEnd`,
        plan: "FLEET",
        fleet_service_plan: "ESSENTIAL",
        fee_bp: 750,
        mc_number: null,
    };
    const copy = packetMessages(hostile, { requestId });
    const texts = [
        copy.name,
        copy.carrier.subject,
        copy.carrier.message,
        copy.dispatch.subject,
        copy.dispatch.message,
    ];
    for (const text of texts) {
        expect(text).not.toMatch(/[{}]/);
        expect(text.length).toBeLessThanOrEqual(1000);
    }
    for (const subject of [
        copy.name,
        copy.carrier.subject,
        copy.dispatch.subject,
    ]) {
        expect(subject.length).toBeLessThanOrEqual(150);
        expect(subject).not.toMatch(/\n/);
    }
    expect(copy.dispatch.subject).toContain("Fleet Essential");
    expect(copy.dispatch.message).toContain("MC none");
    expect(copy.dispatch.message).toContain("fee 7.5%");
    expect(plain("a\u0000b", 10)).toBe("a b");
});
