// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import { isRunDue, runEndUtc } from "./schedule.js";
import { startRun } from "./runService.js";
import { chargeApprovedRun, runDueRetries } from "./charger.js";
export async function reconcileOnStart(deps) {
    const runs = await deps.store.listRunsByStatus([
        "building",
        "approved",
        "charging",
    ]);
    for (const run of runs) {
        if (run.status === "building")
            await (deps.startRun ?? startRun)({ now: run.run_end }, deps);
        else await (deps.chargeApprovedRun ?? chargeApprovedRun)(run.id, deps);
    }
}
export function startScheduler(deps, intervalMs = 900000) {
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            const now = deps.now?.() ?? new Date();
            await (deps.runDueRetries ?? runDueRetries)(now, deps);
            await reconcileOnStart(deps);
            const { config } = deps;
            if (
                config.autoRun &&
                isRunDue(now, config.timezone, config.runHour) &&
                !(await deps.store.getRunByEnd(runEndUtc(now, config.timezone)))
            )
                await (deps.startRun ?? startRun)({ now }, deps);
        } catch {
            deps.logger?.error({ code: "interim_billing_tick_failed" });
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => {
        void tick();
    }, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer), tick };
}
