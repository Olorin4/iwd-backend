// TEMPORARY: delete when the KelevoTMS dispatching-agency billing feature is live. See DISPOSE.md.
import {
    startScheduler,
    reconcileOnStart,
} from "../../src/interimBilling/scheduler.js";
import { startInterimBilling } from "../../src/interimBilling/index.js";
import { fakeStore } from "./fakeStore.js";
jest.mock("../../src/logging.js", () => ({
    logger: { info: jest.fn(), error: jest.fn() },
}));
let deps;
beforeEach(() => {
    jest.useFakeTimers();
    deps = {
        config: { autoRun: false, timezone: "America/Chicago", runHour: 6 },
        store: fakeStore(),
        now: () => new Date("2026-11-20T12:00:00Z"),
        runDueRetries: jest.fn(),
        startRun: jest.fn(async ({ now }) =>
            deps.store.claimRun(new Date("2026-11-16T06:00:00Z"))
        ),
        chargeApprovedRun: jest.fn(),
        logger: { error: jest.fn() },
    };
});
afterEach(() => jest.useRealTimers());
it("runs retries with autorun off", async () => {
    const scheduler = startScheduler(deps);
    await scheduler.tick();
    expect(deps.runDueRetries).toHaveBeenCalled();
    expect(deps.startRun).not.toHaveBeenCalled();
    scheduler.stop();
});
it("starts one Friday run across repeated ticks", async () => {
    deps.config.autoRun = true;
    const scheduler = startScheduler(deps);
    await scheduler.tick();
    deps.store.runs[0].status = "awaiting_approval";
    await scheduler.tick();
    expect(deps.startRun).toHaveBeenCalledTimes(1);
    scheduler.stop();
});
it("resumes building, approved and charging runs while leaving others alone", async () => {
    deps.store.runs.push(
        {
            id: 1,
            status: "building",
            run_end: new Date("2026-11-16T06:00:00Z"),
        },
        { id: 2, status: "charging" },
        { id: 3, status: "awaiting_approval" },
        { id: 4, status: "approved" }
    );
    await reconcileOnStart(deps);
    expect(deps.startRun).toHaveBeenCalledWith(
        { now: new Date("2026-11-16T06:00:00Z") },
        deps
    );
    expect(deps.chargeApprovedRun.mock.calls.map((c) => c[0])).toEqual([2, 4]);
});
it("disabled entry point does nothing", async () => {
    expect(
        await startInterimBilling({ getConfig: () => ({ enabled: false }) })
    ).toBeUndefined();
});
