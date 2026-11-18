import {
    SIGNWELL_BASE_URL,
    createSignwellProvider,
    signSignwellEvent,
    verifySignwellEvent,
    toSignwellBox,
    DEFAULT_CALIBRATION,
} from "../../src/onboarding/signature/signwell";
import { normalizeProviderStatus } from "../../src/onboarding/signature/errors";

const API_KEY = "signwell-api-key-never-logged";
const json = (status, body) => ({
    ok: status < 400,
    status,
    json: async () => body,
    arrayBuffer: async () => new ArrayBuffer(0),
});

function provider(responses, options = {}) {
    const calls = [];
    const fetch = jest.fn(async (url, init) => {
        calls.push({
            url,
            init,
            body: init.body ? JSON.parse(init.body) : null,
        });
        const next = responses.shift();
        if (next instanceof Error) throw next;
        return next;
    });
    return {
        calls,
        p: createSignwellProvider({ apiKey: API_KEY, fetch, ...options }),
    };
}

const filled = {
    files: [
        {
            name: "packet.pdf",
            bytes: Buffer.from("%PDF-1.7 filled"),
            fields: [
                {
                    kind: "signwell",
                    recipient: 1,
                    type: "signature",
                    page: 1,
                    x: 10,
                    y: 20,
                    w: 100,
                    h: 20,
                },
                {
                    kind: "signwell",
                    recipient: 2,
                    type: "date (lock_sign_date)",
                    page: 2,
                    x: 30,
                    y: 40,
                    w: 50,
                    h: 10,
                },
            ],
        },
    ],
};
const signers = [
    { id: "1", role: "Carrier", name: "Sam", email: "sam@example.test" },
    { id: "2", role: "Dispatch", name: "Lead", email: "lead@example.test" },
];
const metadata = {
    onboarding_request_id: "req-1",
    envelope_id: "env-1",
    name: "Agreement",
    subject: "Sign",
    message: "Please sign",
    redirect_url: "https://api.example.test/onboarding/continue/tok",
};

it("creates a draft document with uploaded files, ordered signers and safe defaults", async () => {
    const { calls, p } = provider([
        json(201, { id: "doc_1", status: "Draft" }),
    ]);
    expect(await p.createEnvelope(filled, signers, metadata)).toEqual({
        id: "doc_1",
        status: "Draft",
    });
    const [call] = calls;
    expect(call.url).toBe(`${SIGNWELL_BASE_URL}/documents/`);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers["X-Api-Key"]).toBe(API_KEY);
    expect(call.body).toMatchObject({
        test_mode: true,
        draft: true,
        apply_signing_order: true,
        reminders: false,
        allow_decline: true,
        expires_in: 14,
        redirect_url: metadata.redirect_url,
        metadata: { onboarding_request_id: "req-1", envelope_id: "env-1" },
        recipients: [
            { id: "1", name: "Sam", email: "sam@example.test" },
            { id: "2", name: "Lead", email: "lead@example.test" },
        ],
        files: [
            {
                name: "packet.pdf",
                file_base64: Buffer.from("%PDF-1.7 filled").toString("base64"),
            },
        ],
    });
    expect(call.body.fields).toEqual([
        [
            {
                type: "signature",
                required: true,
                page: 1,
                x: 10,
                y: 20,
                width: 100,
                height: 20,
                recipient_id: "1",
                api_id: "r1_signature_1",
            },
            {
                type: "date",
                required: true,
                page: 2,
                x: 30,
                y: 40,
                width: 50,
                height: 10,
                recipient_id: "2",
                api_id: "r2_date_2",
                lock_sign_date: true,
            },
        ],
    ]);
});

it("converts boxes through one calibration function (identity by default)", () => {
    const field = { page: 3, x: 100, y: 50, w: 20, h: 10 };
    expect(toSignwellBox(field)).toEqual({
        page: 3,
        x: 100,
        y: 50,
        width: 20,
        height: 10,
    });
    expect(
        toSignwellBox(field, { scale: 1.5, offsetX: 2, offsetY: -1 })
    ).toEqual({
        page: 3,
        x: 152,
        y: 74,
        width: 30,
        height: 15,
    });
    expect(DEFAULT_CALIBRATION.calibrated).toBe(false);
});

it("sends with the test-mode flag and maps timeouts and errors to safe codes", async () => {
    const timeout = Object.assign(new Error("t"), { name: "TimeoutError" });
    const { calls, p } = provider(
        [json(200, {}), timeout, json(422, {}), json(502, {})],
        { testMode: false }
    );
    await p.send("doc_1");
    expect(calls[0].url).toBe(`${SIGNWELL_BASE_URL}/documents/doc_1/send/`);
    expect(calls[0].body).toEqual({ test_mode: false });
    await expect(p.send("doc_1")).rejects.toMatchObject({
        code: "provider_timeout",
        ambiguous: true,
    });
    await expect(p.send("doc_1")).rejects.toMatchObject({
        code: "provider_http_422",
        ambiguous: false,
    });
    const error = await p.send("doc_1").catch((e) => e);
    expect(error).toMatchObject({ code: "provider_http_502", ambiguous: true });
    expect(JSON.stringify(error) + error.message + error.stack).not.toContain(
        API_KEY
    );
});

it("downloads the completed PDF with the audit page and refuses non-PDF bytes", async () => {
    const pdf = Buffer.from("%PDF-1.7 done");
    const { calls, p } = provider([
        {
            ok: true,
            status: 200,
            arrayBuffer: async () =>
                pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.length),
        },
        {
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode("<html>").buffer,
        },
    ]);
    expect((await p.downloadCompleted("doc_1")).equals(pdf)).toBe(true);
    expect(calls[0].url).toBe(
        `${SIGNWELL_BASE_URL}/documents/doc_1/completed_pdf/?url_only=false&audit_page=true`
    );
    await expect(p.downloadCompleted("doc_1")).rejects.toMatchObject({
        code: "completed_pdf_invalid",
    });
});

it("verifies the event hash: HMAC-SHA256(webhook id, type@canonical time)", () => {
    const hash = signSignwellEvent("document_completed", 1700000000, "hook-id");
    const event = { type: "document_completed", time: 1700000000, hash };
    expect(verifySignwellEvent({ event }, "hook-id")).toEqual({
        type: "document_completed",
        time: "1700000000",
        expected: hash,
    });
    // An all-digit string time is accepted in canonical form.
    expect(
        verifySignwellEvent(
            { event: { ...event, time: "1700000000" } },
            "hook-id"
        )
    ).not.toBeNull();
    expect(verifySignwellEvent({ event }, "other-id")).toBeNull();
    expect(
        verifySignwellEvent(
            { event: { ...event, type: "document_declined" } },
            "hook-id"
        )
    ).toBeNull();
    expect(
        verifySignwellEvent(
            { event: { ...event, hash: hash.toUpperCase() } },
            "hook-id"
        )
    ).toBeNull();
    expect(
        verifySignwellEvent(
            { event: { ...event, hash: `${hash}0` } },
            "hook-id"
        )
    ).toBeNull();
    expect(
        verifySignwellEvent({ event: { ...event, hash: "zz" } }, "hook-id")
    ).toBeNull();
    for (const time of [
        1700000000.5,
        "1700000000.0",
        "1e9",
        -1,
        null,
        "01700000000x",
    ])
        expect(
            verifySignwellEvent({ event: { ...event, time } }, "hook-id")
        ).toBeNull();
    expect(verifySignwellEvent({}, "hook-id")).toBeNull();
});

it("normalizes provider statuses", () => {
    expect(normalizeProviderStatus("Draft")).toBe("DRAFT");
    expect(normalizeProviderStatus("pending")).toBe("SENT");
    expect(normalizeProviderStatus("Completed")).toBe("COMPLETED");
    expect(normalizeProviderStatus("canceled")).toBe("CANCELLED");
    expect(normalizeProviderStatus("whatever")).toBeNull();
});
