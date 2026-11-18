import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
    assertOnlyRecipient,
    assertPdfHash,
    assertSandboxEnvironment,
    createEmailBudget,
} from "../../src/onboarding/sandbox";

const env = {
    ONBOARDING_SANDBOX_CONFIRM: "yes",
    ONBOARDING_SANDBOX_RECIPIENT: "owner@example.test",
    ONBOARDING_STRIPE_SECRET_KEY: "sk_test_abc",
    ONBOARDING_SANDBOX_BUDGET_FILE: "/tmp/budget.json",
    DB_URL: "postgresql://u:p@localhost:5432/iwd_onboarding_sandbox",
};

it("refuses unless every sandbox precondition holds", () => {
    expect(assertSandboxEnvironment(env)).toBe("owner@example.test");
    for (const change of [
        { ONBOARDING_SANDBOX_CONFIRM: "true" },
        { ONBOARDING_SANDBOX_RECIPIENT: "a@example.test,b@example.test" },
        { ONBOARDING_SANDBOX_RECIPIENT: "" },
        { ONBOARDING_STRIPE_SECRET_KEY: "sk_live_abc" },
        { ONBOARDING_STRIPE_LIVE_CONFIRM: "yes" },
        { ONBOARDING_SIGNWELL_TEST_MODE: "false" },
        { ONBOARDING_SANDBOX_BUDGET_FILE: "" },
        { DB_URL: "postgresql://u:p@localhost:5432/iwd" },
        { OUTREACH_STATUS_URL: "https://outreach.example.test/x" },
    ])
        expect(() => assertSandboxEnvironment({ ...env, ...change })).toThrow();
});

it("allows only the single recipient and the expected PDF", () => {
    expect(() =>
        assertOnlyRecipient(["OWNER@example.test"], "owner@example.test")
    ).not.toThrow();
    expect(() =>
        assertOnlyRecipient(["other@example.test"], "owner@example.test")
    ).toThrow();
    const bytes = Buffer.from("%PDF-1.7");
    const hash = require("node:crypto")
        .createHash("sha256")
        .update(bytes)
        .digest("hex");
    expect(() => assertPdfHash(bytes, hash)).not.toThrow();
    expect(() => assertPdfHash(bytes, "0".repeat(64))).toThrow(
        /does not match/
    );
    expect(() => assertPdfHash(bytes, "short")).toThrow();
});

it("caps provider emails at 10 across runs and fails closed on a corrupt counter", () => {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "budget-")),
        "budget.json"
    );
    const budget = createEmailBudget(file);
    expect(budget.reserve(4, "packet")).toBe(4);
    expect(createEmailBudget(file).reserve(4, "packet")).toBe(8);
    expect(() => budget.reserve(4, "packet")).toThrow(/budget exhausted/);
    expect(budget.reserve(1, "email")).toBe(9);
    expect(budget.reserve(1, "email")).toBe(10);
    expect(() => budget.reserve(1, "email")).toThrow(/budget exhausted/);
    fs.writeFileSync(file, "garbage");
    expect(() => createEmailBudget(file).reserve(1, "email")).toThrow(
        /budget exhausted/
    );
});
