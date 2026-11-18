// Guards for the sandbox acceptance script (scripts/onboarding-sandbox.js).
// Owner ruling R4: at most 10 provider emails in total, all to one controlled
// address, SignWell test mode and Stripe sandbox keys only.
import fs from "node:fs";
import { createHash } from "node:crypto";

export const EMAIL_BUDGET = 10;
// A packet send can email the Carrier and the Dispatch recipient, and each may
// get a completion copy: reserve 4 per send. A payment link email costs 1.
export const COST = { packetSend: 4, email: 1 };

export class SandboxRefusal extends Error {
    constructor(message) {
        super(message);
        this.name = "SandboxRefusal";
    }
}

const dbName = (url) => {
    const path = String(url ?? "").split("?")[0];
    return path.slice(path.lastIndexOf("/") + 1);
};

const ONE_ADDRESS = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/**
 * Throws SandboxRefusal unless every precondition holds. Returns the controlled
 * recipients: { carrier, dispatch }. Either one address for both roles
 * (ONBOARDING_SANDBOX_RECIPIENT) or exactly two role addresses
 * (ONBOARDING_SANDBOX_CARRIER_RECIPIENT + ONBOARDING_SANDBOX_DISPATCH_RECIPIENT).
 */
export function assertSandboxEnvironment(env) {
    if (env.ONBOARDING_SANDBOX_CONFIRM !== "yes")
        throw new SandboxRefusal(
            "Set ONBOARDING_SANDBOX_CONFIRM=yes to run the sandbox acceptance."
        );
    const single = String(env.ONBOARDING_SANDBOX_RECIPIENT ?? "").trim();
    const carrier = String(
        env.ONBOARDING_SANDBOX_CARRIER_RECIPIENT ?? single
    ).trim();
    const dispatch = String(
        env.ONBOARDING_SANDBOX_DISPATCH_RECIPIENT ?? single
    ).trim();
    if (!ONE_ADDRESS.test(carrier) || !ONE_ADDRESS.test(dispatch))
        throw new SandboxRefusal(
            "Set ONBOARDING_SANDBOX_RECIPIENT, or both ONBOARDING_SANDBOX_CARRIER_RECIPIENT and ONBOARDING_SANDBOX_DISPATCH_RECIPIENT, each to exactly one email address."
        );
    if (!/^(sk|rk)_test_/.test(env.ONBOARDING_STRIPE_SECRET_KEY ?? ""))
        throw new SandboxRefusal(
            "ONBOARDING_STRIPE_SECRET_KEY must be a Stripe test key."
        );
    if (env.ONBOARDING_STRIPE_LIVE_CONFIRM)
        throw new SandboxRefusal(
            "ONBOARDING_STRIPE_LIVE_CONFIRM must not be set for the sandbox."
        );
    if (
        ["0", "false", "no"].includes(
            String(env.ONBOARDING_SIGNWELL_TEST_MODE ?? "true").toLowerCase()
        )
    )
        throw new SandboxRefusal(
            "ONBOARDING_SIGNWELL_TEST_MODE must stay true for the sandbox."
        );
    if (!env.ONBOARDING_SANDBOX_BUDGET_FILE)
        throw new SandboxRefusal(
            "ONBOARDING_SANDBOX_BUDGET_FILE is required (it persists the email budget)."
        );
    if (!/_(test|sandbox)$/.test(dbName(env.DB_URL)))
        throw new SandboxRefusal(
            "DB_URL must name a database ending in _test or _sandbox."
        );
    if (env.OUTREACH_STATUS_URL)
        throw new SandboxRefusal(
            "Unset OUTREACH_STATUS_URL: the sandbox never posts status to Outreach."
        );
    return { carrier, dispatch };
}

/** Every address the run may email must be one of the controlled recipients. */
export function assertOnlyRecipient(addresses, allowed) {
    const list = (Array.isArray(allowed) ? allowed : [allowed]).map((a) =>
        String(a).toLowerCase()
    );
    for (const address of addresses)
        if (!list.includes(String(address).toLowerCase()))
            throw new SandboxRefusal(
                "Every sandbox email must go to a controlled sandbox recipient."
            );
}

export function assertPdfHash(bytes, expected) {
    if (!/^[0-9a-f]{64}$/.test(String(expected ?? "")))
        throw new SandboxRefusal(
            "--sha256 must be the 64-character hex hash of the release PDF."
        );
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected)
        throw new SandboxRefusal("The PDF does not match the expected sha256.");
}

/**
 * Hard cap persisted in a file: reserve(n) records the spend before the email
 * can happen and refuses once the total would exceed the budget. The file is
 * never reset by the script.
 */
export function createEmailBudget(file, cap = EMAIL_BUDGET) {
    const read = () => {
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8"));
            return Number.isInteger(data.used) && data.used >= 0
                ? data.used
                : cap;
        } catch (error) {
            if (error.code === "ENOENT") return 0;
            return cap; // unreadable counter: fail closed
        }
    };
    return {
        used: read,
        reserve(n, label) {
            const used = read();
            if (used + n > cap)
                throw new SandboxRefusal(
                    `Email budget exhausted: ${used}/${cap} used, ${label} needs ${n}.`
                );
            fs.writeFileSync(
                file,
                JSON.stringify({
                    used: used + n,
                    cap,
                    last: label,
                    at: new Date().toISOString(),
                })
            );
            return used + n;
        },
    };
}
