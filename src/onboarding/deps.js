import { recordReceipt } from "./store.js";

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
        onRequestCreated: async () => {},
        ...overrides,
    };
    return deps;
}
