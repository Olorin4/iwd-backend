import { recordReceipt } from "./store.js";
import { createFileDocumentStore } from "./documents/store.js";
import { createSignwellProvider } from "./signature/signwell.js";
import { createFakeSignatureProvider } from "./signature/fake.js";
import { sendPacket } from "./signatureFlow.js";

function signatureFromConfig(config) {
    if (config.signature.provider === "fake")
        return createFakeSignatureProvider();
    return createSignwellProvider({
        apiKey: config.signature.apiKey,
        testMode: config.signature.testMode,
        expiresInDays: config.signature.expiresInDays,
        timeoutMs: config.signature.timeoutMs,
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
        onSignatureCompleted: async () => {},
        ...overrides,
    };
    if (!deps.documentStore)
        deps.documentStore = createFileDocumentStore(config.documents);
    if (!deps.signature) deps.signature = signatureFromConfig(config);
    return deps;
}
