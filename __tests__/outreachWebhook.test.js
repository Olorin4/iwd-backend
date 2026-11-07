import { notifyOutreach } from "../src/outreachWebhook";
import { logger } from "../src/logging.js";

jest.mock("../src/logging.js", () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const URL_ = "https://outreach.example/hooks/conversion";
const env = {
    OUTREACH_CONVERSION_WEBHOOK_URL: URL_,
    OUTREACH_WEBHOOK_TOKEN: "tok",
};
const lead = {
    type: "sign_up",
    outreachRef: "ref-123",
    email: "carrier@example.com",
    leadId: 42,
};
const res = (status) => ({ ok: status >= 200 && status < 300, status });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("notifyOutreach", () => {
    let sleep;
    beforeEach(() => {
        sleep = jest.fn().mockResolvedValue(undefined);
    });

    it("skips when the URL or token is unset", async () => {
        const fetchImpl = jest.fn();
        for (const e of [
            {},
            { OUTREACH_CONVERSION_WEBHOOK_URL: URL_ },
            { OUTREACH_WEBHOOK_TOKEN: "tok" },
            {
                OUTREACH_CONVERSION_WEBHOOK_URL: "",
                OUTREACH_WEBHOOK_TOKEN: "tok",
            },
            {
                OUTREACH_CONVERSION_WEBHOOK_URL: URL_,
                OUTREACH_WEBHOOK_TOKEN: "",
            },
        ]) {
            expect(
                await notifyOutreach(lead, { fetchImpl, sleep, env: e })
            ).toBe("skipped");
        }
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("skips with no ref and no email", async () => {
        const fetchImpl = jest.fn();
        const result = await notifyOutreach(
            { ...lead, outreachRef: null, email: null },
            { fetchImpl, sleep, env }
        );
        expect(result).toBe("skipped");
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("sends the body and bearer token", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(200));
        const result = await notifyOutreach(
            { ...lead, occurredAt: "2026-11-07T12:00:00.000Z" },
            { fetchImpl, sleep, env }
        );
        expect(result).toBe("sent");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe(URL_);
        expect(init.method).toBe("POST");
        expect(init.headers["Content-Type"]).toBe("application/json");
        expect(init.headers.Authorization).toBe("Bearer tok");
        expect(init.redirect).toBe("error");
        const body = JSON.parse(init.body);
        expect(Object.keys(body).sort()).toEqual(
            [
                "brand",
                "email",
                "event_id",
                "lead_id",
                "occurred_at",
                "outreach_ref",
                "type",
            ].sort()
        );
        expect(body.event_id).toMatch(UUID);
        expect(body).toMatchObject({
            type: "sign_up",
            brand: "IRON_WING",
            outreach_ref: "ref-123",
            email: "carrier@example.com",
            occurred_at: "2026-11-07T12:00:00.000Z",
            lead_id: 42,
        });
    });

    it("defaults occurred_at to now as an ISO string", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(200));
        await notifyOutreach(lead, { fetchImpl, sleep, env });
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(new Date(body.occurred_at).toISOString()).toBe(body.occurred_at);
    });

    it("sends with only an email", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(200));
        const result = await notifyOutreach(
            { ...lead, outreachRef: undefined },
            { fetchImpl, sleep, env }
        );
        expect(result).toBe("sent");
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.outreach_ref).toBeNull();
        expect(body.email).toBe("carrier@example.com");
    });

    it("sends with only a ref", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(200));
        const result = await notifyOutreach(
            { ...lead, email: undefined },
            { fetchImpl, sleep, env }
        );
        expect(result).toBe("sent");
        const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
        expect(body.email).toBeNull();
        expect(body.outreach_ref).toBe("ref-123");
    });

    it("retries on 503 then succeeds", async () => {
        const fetchImpl = jest
            .fn()
            .mockResolvedValueOnce(res(503))
            .mockResolvedValueOnce(res(200));
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("sent");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledWith(1000);
    });

    it("does not retry on 400", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(400));
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("rejected");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.warn.mock.calls)).toContain("400");
    });

    it("gives up after 3 attempts on network errors", async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNRESET"));
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("failed");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual([[1000], [5000]]);
    });

    it("retries a refused redirect like a network error", async () => {
        // With redirect: "error", fetch rejects on any 3xx.
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(
                new TypeError("fetch failed", {
                    cause: new Error("unexpected redirect"),
                })
            )
            .mockResolvedValueOnce(res(200));
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("sent");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(1000);
    });

    it("cancels the body of non-2xx responses", async () => {
        const rejected = { ...res(400), body: { cancel: jest.fn() } };
        const retried = { ...res(503), body: { cancel: jest.fn() } };
        const ok = { ...res(200), body: { cancel: jest.fn() } };
        expect(
            await notifyOutreach(lead, {
                fetchImpl: jest.fn().mockResolvedValue(rejected),
                sleep,
                env,
            })
        ).toBe("rejected");
        expect(
            await notifyOutreach(lead, {
                fetchImpl: jest
                    .fn()
                    .mockResolvedValueOnce(retried)
                    .mockResolvedValueOnce(ok),
                sleep,
                env,
            })
        ).toBe("sent");
        expect(rejected.body.cancel).toHaveBeenCalledTimes(1);
        expect(retried.body.cancel).toHaveBeenCalledTimes(1);
        expect(ok.body.cancel).not.toHaveBeenCalled();
    });

    it("ignores a body cancel that throws or rejects", async () => {
        const throws = {
            ...res(503),
            body: {
                cancel: () => {
                    throw new Error("boom");
                },
            },
        };
        const rejects = {
            ...res(400),
            body: { cancel: () => Promise.reject(new Error("boom")) },
        };
        expect(
            await notifyOutreach(lead, {
                fetchImpl: jest
                    .fn()
                    .mockResolvedValueOnce(throws)
                    .mockResolvedValueOnce(rejects),
                sleep,
                env,
            })
        ).toBe("rejected");
    });

    it("gives up after 3 attempts on 5xx", async () => {
        const fetchImpl = jest.fn().mockResolvedValue(res(500));
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("failed");
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(sleep.mock.calls).toEqual([[1000], [5000]]);
    });

    it("times out a hanging request and retries", async () => {
        const timeoutSpy = jest.spyOn(AbortSignal, "timeout");
        const fetchImpl = jest
            .fn()
            .mockImplementationOnce(
                (url, { signal }) =>
                    new Promise((resolve, reject) => {
                        signal.addEventListener("abort", () =>
                            reject(signal.reason)
                        );
                    })
            )
            .mockResolvedValueOnce(res(200));
        // Make the first attempt's signal fire promptly instead of waiting 10 s.
        timeoutSpy.mockImplementationOnce((ms) => {
            expect(ms).toBe(10000);
            const c = new AbortController();
            setTimeout(() => c.abort(new Error("timeout")), 5);
            return c.signal;
        });
        const result = await notifyOutreach(lead, { fetchImpl, sleep, env });
        expect(result).toBe("sent");
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
        expect(sleep).toHaveBeenCalledWith(1000);
        expect(timeoutSpy).toHaveBeenCalledWith(10000);
        timeoutSpy.mockRestore();
    });

    it("uses one event_id across retries", async () => {
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(res(502))
            .mockResolvedValueOnce(res(200));
        await notifyOutreach(lead, { fetchImpl, sleep, env });
        const ids = fetchImpl.mock.calls.map(
            ([, init]) => JSON.parse(init.body).event_id
        );
        expect(ids).toHaveLength(3);
        expect(new Set(ids).size).toBe(1);
    });

    it("never logs the token or the full email", async () => {
        const fetchImpl = jest
            .fn()
            .mockRejectedValueOnce(new Error("boom"))
            .mockResolvedValueOnce(res(400));
        await notifyOutreach(lead, { fetchImpl, sleep, env });
        const logged = JSON.stringify([
            ...logger.info.mock.calls,
            ...logger.warn.mock.calls,
            ...logger.error.mock.calls,
        ]);
        expect(logged).not.toContain('"tok"');
        expect(logged).not.toContain("Bearer");
        expect(logged).not.toContain("carrier@example.com");
    });
});
