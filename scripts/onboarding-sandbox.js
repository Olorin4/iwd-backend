// Sandbox acceptance for client onboarding (plan I7, owner ruling R4).
// NOT run by CI or by the implementation agents. It uses SignWell TEST MODE
// and Stripe SANDBOX keys only, sends at most 10 provider emails in total
// (persisted counter), all to ONBOARDING_SANDBOX_RECIPIENT, and never posts
// status to Outreach.
//
// Usage (after `npx prisma migrate deploy` on a *_test or *_sandbox database):
//   ONBOARDING_SANDBOX_CONFIRM=yes ONBOARDING_SANDBOX_RECIPIENT=owner@example.com \
//   ONBOARDING_SANDBOX_BUDGET_FILE=/private/onboarding-sandbox-budget.json \
//   node -r dotenv/config scripts/onboarding-sandbox.js start \
//       --pdf /path/Iron-Wing-Onboarding-Packet-v1.pdf --sha256 <expected hex> \
//       --layout docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.draft.json
//   node -r dotenv/config scripts/onboarding-sandbox.js status --key <idempotency key>
//   node -r dotenv/config scripts/onboarding-sandbox.js reconcile --key <idempotency key>
//
// Plus the normal ONBOARDING_* settings (docs/operations/client-onboarding.md).
// The bundle is registered under a sandbox-only name and approved as
// "sandbox"; the production bundle name is never touched.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { prisma } from "../src/prismaClient.js";
import { getOnboardingConfig } from "../src/onboarding/config.js";
import { createOnboardingDeps } from "../src/onboarding/deps.js";
import { termsHash } from "../src/onboarding/canonical.js";
import { putRequest, getRequestStatus } from "../src/onboarding/requests.js";
import {
    sendPacket,
    reconcileSignature,
} from "../src/onboarding/signatureFlow.js";
import { reconcilePayment } from "../src/onboarding/paymentFlow.js";
import {
    registerBundle,
    approveBundle,
} from "../src/onboarding/documents/bundles.js";
import { sendEmail } from "../src/emailService.js";
import {
    COST,
    assertOnlyRecipient,
    assertPdfHash,
    assertSandboxEnvironment,
    createEmailBudget,
} from "../src/onboarding/sandbox.js";

function args(argv) {
    const [command, ...rest] = argv;
    const options = {};
    for (let i = 0; i < rest.length; i += 2)
        options[rest[i].replace(/^--/, "")] = rest[i + 1];
    return { command, options };
}

async function main() {
    const recipient = assertSandboxEnvironment(process.env);
    const budget = createEmailBudget(
        process.env.ONBOARDING_SANDBOX_BUDGET_FILE
    );
    const base = getOnboardingConfig({
        ...process.env,
        ONBOARDING_ENABLED: "1",
    });
    // The countersigner is the same controlled address in the sandbox.
    const config = {
        ...base,
        bundleName: `sandbox-${base.bundleName}`,
        signature: {
            ...base.signature,
            testMode: true,
            countersigner: {
                ...base.signature.countersigner,
                email: recipient,
            },
        },
        outbox: { enabled: false },
        reconcile: { enabled: false },
    };
    const logger = {
        info: (e) => console.log(JSON.stringify(e)),
        warn: (e) => console.warn(JSON.stringify(e)),
        error: (e) => console.error(JSON.stringify(e)),
    };
    const deps = createOnboardingDeps(config, {
        db: prisma,
        logger,
        sendEmail: async (mail) => {
            assertOnlyRecipient([mail.to], recipient);
            budget.reserve(COST.email, "payment link email");
            return sendEmail(mail);
        },
        schedule: async (fn) => fn(),
    });
    const send = deps.signature.send.bind(deps.signature);
    deps.signature.send = async (id) => {
        budget.reserve(COST.packetSend, "packet send");
        return send(id);
    };
    const { command, options } = args(process.argv.slice(2));

    if (command === "start") {
        const bytes = fs.readFileSync(options.pdf);
        assertPdfHash(bytes, options.sha256);
        if (budget.used() + COST.packetSend > 10)
            throw new Error("Email budget too low for a packet send.");
        const layout = JSON.parse(fs.readFileSync(options.layout, "utf8"));
        const existing = await prisma.documentBundleVersion.findFirst({
            where: { name: config.bundleName, status: "APPROVED" },
            orderBy: { version: "desc" },
        });
        if (!existing) {
            const draft = await registerBundle(prisma, deps.documentStore, {
                name: config.bundleName,
                version: 1,
                pdfs: [{ name: layout.bundle, bytes }],
                layout,
            });
            await approveBundle(prisma, deps.documentStore, {
                id: draft.id,
                by: "sandbox",
            });
        }
        const key = randomUUID();
        const terms = {
            path: "IRON_WING_CARRIER_CLIENT",
            legal_name: "Sandbox Freight LLC",
            dba_name: null,
            mc_number: "MC000000",
            usdot: String(9000000 + Math.floor(Math.random() * 999999)),
            recipient_email: recipient,
            signer: {
                name: "Sandbox Signer",
                title: "Owner",
                email: recipient,
            },
            plan: "FULL_SERVICE",
            fleet_service_plan: null,
            truck_count: 1,
            fee_bp: 1000,
            effective_date: new Date(Date.now() + 7 * 86400000)
                .toISOString()
                .slice(0, 10),
            payment_methods: ["card", "us_bank_account"],
            primary_payment_method: "card",
            statement_email: null,
            notes_for_packet: null,
        };
        assertOnlyRecipient(
            [
                terms.recipient_email,
                terms.signer.email,
                config.signature.countersigner.email,
            ],
            recipient
        );
        const body = {
            contract: "onboarding.request.v1",
            idempotency_key: key,
            source: "outreach",
            source_refs: {
                workspace_id: "sandbox",
                brand: "iron-wing",
                opportunity_id: "sandbox",
                party_id: "sandbox",
                request_id: key,
            },
            actor: { user_id: "sandbox", email: recipient },
            terms,
            terms_hash: termsHash(terms),
            confirmed_at: new Date().toISOString(),
        };
        const created = await putRequest(deps, key, body);
        await sendPacket(deps, created.row.id);
        console.log(
            JSON.stringify(
                {
                    key,
                    status: await getRequestStatus(deps, key),
                    emails_used: budget.used(),
                },
                null,
                2
            )
        );
        return;
    }
    if (command === "status" || command === "reconcile") {
        if (!options.key) throw new Error("--key is required.");
        if (command === "reconcile") {
            const row = await prisma.onboardingRequest.findUnique({
                where: { idempotency_key: options.key },
            });
            if (!row) throw new Error("Unknown key.");
            await reconcileSignature(deps, row.id);
            await reconcilePayment(deps, row.id);
        }
        console.log(
            JSON.stringify(
                {
                    status: await getRequestStatus(deps, options.key),
                    emails_used: budget.used(),
                },
                null,
                2
            )
        );
        return;
    }
    throw new Error(
        "Usage: onboarding-sandbox.js start|status|reconcile (see the header comment)."
    );
}

try {
    await main();
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
