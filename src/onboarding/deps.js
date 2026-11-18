import Anthropic from "@anthropic-ai/sdk";
import { extractDocument } from "./reader/claude.js";
import { fileStoreFromConfig } from "./files/r2Store.js";
import { recordReceipt } from "./store.js";
import { createFileDocumentStore } from "./documents/store.js";
import { createSignwellProvider } from "./signature/signwell.js";
import { createFakeSignatureProvider } from "./signature/fake.js";
import { reconcileSignature, sendPacket } from "./signatureFlow.js";
import { issuePaymentLink } from "./paymentFlow.js";
import { sendCompletionEmail } from "./documentsFlow.js";
import { createPaymentsStripe } from "../payments/index.js";
import { startProvisioning } from "./provisioningFlow.js";
import { provisioningFromConfig } from "./provisioning/adapters.js";

function signatureFromConfig(config) {
    if (config.signature.provider === "fake")
        return createFakeSignatureProvider();
    return createSignwellProvider({
        apiKey: config.signature.apiKey,
        testMode: config.signature.testMode,
        expiresInDays: config.signature.expiresInDays,
        timeoutMs: config.signature.timeoutMs,
        calibration: config.signature.calibration,
    });
}

/**
 * Builds the dependency bag used by routes, services and workers. Production
 * wiring passes the real Prisma client, logger and email sender; tests pass
 * fakes. Nothing here starts timers or performs I/O.
 */
export function createOnboardingDeps(
    config,
    { db, logger, sendEmail, ...overrides }
) {
    const deps = {
        config,
        db,
        logger,
        sendEmail,
        now: () => new Date(),
        // Work after commit, off the request path. Errors are logged by code only.
        schedule: (fn) =>
            setImmediate(() =>
                Promise.resolve()
                    .then(fn)
                    .catch((error) =>
                        deps.logger?.error({
                            code: "onboarding_async_failed",
                            reason: error?.code ?? "error",
                        })
                    )
            ),
        recordReceipt: (provider, key) => recordReceipt(db, provider, key),
        onRequestCreated: (row) => sendPacket(deps, row.id),
        // R15: the combined completion email goes out even when the payment
        // link is skipped (e.g. the carrier already saved a method via the
        // SignWell redirect); it is claimed once per request.
        onSignatureCompleted: async (requestId) => {
            const row = await db.onboardingRequest.findUnique({
                where: { id: requestId },
            });
            if (row?.portal_flow) return;
            try {
                await issuePaymentLink(deps, requestId, { mode: "initial" });
            } finally {
                await sendCompletionEmail(deps, requestId);
            }
        },
        onPaymentReady: (requestId) => startProvisioning(deps, requestId),
        reconcileSignature: (requestId) => reconcileSignature(deps, requestId),
        ...overrides,
    };
    if (!deps.documentStore)
        deps.documentStore = createFileDocumentStore(config.documents);
    if (!deps.signature) deps.signature = signatureFromConfig(config);
    if (!deps.stripe) deps.stripe = createPaymentsStripe(config.stripe);
    if (!deps.provisioning) deps.provisioning = provisioningFromConfig(config);
    if (!deps.fileStore && config.files?.r2)
        deps.fileStore = fileStoreFromConfig(config.files);
    if (!deps.extractDocument && config.reader?.enabled) {
        const reader = {
            client: new Anthropic({
                apiKey: config.reader.apiKey,
                timeout: 90000,
                maxRetries: 0,
                logLevel: "off",
            }),
            model: config.reader.model,
        };
        deps.extractDocument = (key, file) =>
            extractDocument(reader, key, file);
    }
    return deps;
}
