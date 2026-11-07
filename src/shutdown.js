/**
 * On SIGTERM or SIGINT, run `shutdownFn` (e.g. flushing queued PostHog events)
 * and then exit. shutdownFn must bound its own duration (shutdownPosthog caps
 * the flush at 5 s) so the exit fits inside `docker stop`'s 10 s. A failing shutdownFn is logged and never blocks the exit.
 * Takes the process as a parameter so it can be tested with a fake.
 */
function registerShutdown(proc, shutdownFn) {
    const onSignal = async () => {
        try {
            await shutdownFn();
        } catch (error) {
            console.error("Shutdown flush failed:", error?.message);
        }
        proc.exit(0);
    };
    proc.on("SIGTERM", onSignal);
    proc.on("SIGINT", onSignal);
}

export { registerShutdown };
