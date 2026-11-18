// Crash recovery: each test writes the intermediate state a process stop
// would leave behind (the after-commit task never ran) and checks that the
// reconcile worker pass and the `reconcile` action restart the next step.
import { prisma } from "../../src/prismaClient";
import { createOnboardingDeps } from "../../src/onboarding/deps";
import { createFakeSignatureProvider } from "../../src/onboarding/signature/fake";
import { reconcileOnce } from "../../src/onboarding/workers";
import {
    BUNDLE,
    approveTestBundle,
    captureLogger,
    cleanTables,
    deleteBundles,
    fixture,
    requestBody,
    serializeSuite,
    startApp,
    taskQueue,
    tempDir,
    testConfig,
} from "./harness";
import { makeSyntheticPacket, syntheticLayout } from "./pdfFixtures";
import { createFakeStripe } from "./fakeStripe";

serializeSuite();

const KEY = fixture("onboarding.request.v1").idempotency_key;
const ACTOR = {
    user_id: "55555555-5555-4555-8555-555555555555",
    email: "closer@example.test",
};
const MIN = 60 * 1000;
let app, deps, config, queue, signature, stripe, sendEmail;

beforeEach(async () => {
    await cleanTables(prisma);
    config = testConfig(tempDir());
    queue = taskQueue();
    signature = createFakeSignatureProvider();
    stripe = createFakeStripe();
    sendEmail = jest.fn().mockResolvedValue({});
    deps = createOnboardingDeps(config, {
        db: prisma,
        logger: captureLogger(),
        sendEmail,
        signature,
        stripe,
        schedule: queue.schedule,
    });
    await approveTestBundle(prisma, deps.documentStore, {
        makePacket: makeSyntheticPacket,
        layout: syntheticLayout(),
    });
    app = await startApp(
        () => config,
        () => deps
    );
});
afterEach(() => app.close());
afterAll(async () => {
    await cleanTables(prisma);
    await deleteBundles(prisma, BUNDLE);
});

const request = () =>
    prisma.onboardingRequest.findUnique({ where: { idempotency_key: KEY } });
const crash = () => queue.tasks.splice(0);
const setRow = (data) =>
    prisma.onboardingRequest.update({ where: { idempotency_key: KEY }, data });
const reconcileAction = () =>
    app.call("POST", `/requests/${KEY}/actions/reconcile`, { actor: ACTOR });

/** A request whose packet went out, before anything else ran. */
async function sentRequest() {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    await queue.drain();
    return request();
}

describe.each([
    ["the reconcile worker", () => reconcileOnce(deps)],
    ["the reconcile action", () => reconcileAction()],
])("crash recovery via %s", (_, recover) => {
    it("(a) signature COMPLETED, payment NOT_STARTED → issues the initial payment link", async () => {
        await sentRequest();
        await setRow({ signature_state: "COMPLETED" });
        await recover();
        await queue.drain();
        const row = await request();
        expect(row.payment_state).toBe("LINK_SENT");
        expect(await prisma.paymentSetup.count()).toBe(1);
        expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it("(b) payment READY, provisioning NOT_STARTED → starts provisioning", async () => {
        await sentRequest();
        await setRow({ signature_state: "COMPLETED", payment_state: "READY" });
        await recover();
        expect(await request()).toMatchObject({
            provisioning_state: "MANUAL_REQUIRED",
            provisioning_code: "manual_provisioning_required",
        });
    });

    it("(c) provisioning PENDING > 10 min → FAILED provisioning_stale, then retry works", async () => {
        await sentRequest();
        await setRow({
            signature_state: "COMPLETED",
            payment_state: "READY",
            provisioning_state: "PENDING",
            provisioning_at: new Date(Date.now() - 5 * MIN),
        });
        await recover();
        expect((await request()).provisioning_state).toBe("PENDING");
        await setRow({ provisioning_at: new Date(Date.now() - 11 * MIN) });
        await recover();
        expect(await request()).toMatchObject({
            provisioning_state: "FAILED",
            provisioning_code: "provisioning_stale",
        });
        const status = (await app.call("GET", `/requests/${KEY}`)).json;
        expect(status.blocked).toEqual({
            code: "provisioning_stale",
            action: "retry_provisioning",
        });
        const retried = await app.call(
            "POST",
            `/requests/${KEY}/actions/retry_provisioning`,
            { actor: ACTOR }
        );
        expect(retried.status).toBe(200);
        expect((await request()).provisioning_state).toBe("MANUAL_REQUIRED");
    });

    it("(d) NOT_SENT with no code: the action sends now, the worker after 10 min", async () => {
        await app.call("PUT", `/requests/${KEY}`, requestBody());
        crash();
        expect((await request()).signature_code).toBeNull();
        await recover();
        if ((await request()).signature_state === "NOT_SENT") {
            // The worker waits 10 minutes for the after-commit send.
            await setRow({ created_at: new Date(Date.now() - 11 * MIN) });
            await recover();
        }
        expect((await request()).signature_state).toBe("SENT");
        expect(signature.calls.send).toBe(1);
    });

    it("leaves a cancelled request alone", async () => {
        await sentRequest();
        await setRow({
            signature_state: "COMPLETED",
            cancelled_at: new Date(),
        });
        await recover();
        await setRow({ payment_state: "READY" });
        await recover();
        const row = await request();
        expect(row.payment_state).toBe("READY");
        expect(row.provisioning_state).toBe("NOT_STARTED");
        expect(await prisma.paymentSetup.count()).toBe(0);
    });
});

it("the worker does not send a fresh NOT_SENT request (< 10 min) itself", async () => {
    await app.call("PUT", `/requests/${KEY}`, requestBody());
    crash();
    await reconcileOnce(deps);
    expect((await request()).signature_state).toBe("NOT_SENT");
    expect(signature.calls.createEnvelope).toBe(0);
});
