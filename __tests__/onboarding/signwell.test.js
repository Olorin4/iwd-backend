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
                    x: 30,
                    y: 60,
                    w: 150,
                    h: 30,
                },
                {
                    kind: "signwell",
                    recipient: 2,
                    type: "date (lock_sign_date)",
                    page: 2,
                    x: 45,
                    y: 90,
                    w: 75,
                    h: 15,
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
                x: 40,
                y: 80,
                width: 200,
                height: 40,
                recipient_id: "1",
                api_id: "r1_signature_1",
            },
            {
                type: "date",
                required: true,
                page: 2,
                x: 60,
                y: 120,
                width: 100,
                height: 20,
                recipient_id: "2",
                api_id: "r2_date_2",
                lock_sign_date: true,
            },
        ],
    ]);
});

it("converts points to SignWell pixels (× 4/3, top-left) through one function", () => {
    // Page 6 carrier signature line of release v1.
    expect(
        toSignwellBox({ page: 6, x: 46.5, y: 670.5, w: 175.2, h: 19.5 })
    ).toEqual({
        page: 6,
        x: 62,
        y: 894,
        width: 233.6,
        height: 26,
    });
    // A letter page maps to 816×1056.
    expect(toSignwellBox({ page: 1, x: 612, y: 792, w: 612, h: 792 })).toEqual({
        page: 1,
        x: 816,
        y: 1056,
        width: 816,
        height: 1056,
    });
    expect(DEFAULT_CALIBRATION).toEqual({
        scale: 4 / 3,
        offsetX: 0,
        offsetY: 0,
    });
    // Still configurable.
    expect(
        toSignwellBox(
            { page: 3, x: 100, y: 50, w: 20, h: 10 },
            { scale: 1.5, offsetX: 2, offsetY: -1 }
        )
    ).toEqual({
        page: 3,
        x: 152,
        y: 74,
        width: 30,
        height: 15,
    });
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

describe("page-6 typed authorization date (owner decision 2026-11-18)", () => {
    const fs = require("node:fs");
    const path = require("node:path");
    const { layoutSchema } = require("../../src/onboarding/documents/layout");
    const {
        signwellFields,
    } = require("../../src/onboarding/signature/signwell");
    const raw = JSON.parse(
        fs.readFileSync(
            path.resolve(
                __dirname,
                "../../docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v1.layout.json"
            ),
            "utf8"
        )
    );

    it("records the v1 decisions and is superseded by v2", () => {
        expect(raw.status).toBe("SUPERSEDED");
        expect(raw.owner_decisions).toContain(
            "page6_date_typed_mm_dd_yy 2026-11-18"
        );
        expect(raw.owner_decisions).toContain(
            "layout_v1_approved_final 2026-11-18 by owner"
        );
    });

    it("maps the three Carrier text fields with custom validation (× 4/3)", () => {
        const [layout] = layoutSchema.parse(raw);
        const fields = layout.fields.filter((f) => f.kind === "signwell");
        const [mapped] = signwellFields([{ fields }]);
        const page6 = mapped.filter((f) => f.page === 6);
        expect(page6.some((f) => f.type === "date")).toBe(false);
        const text = page6.filter((f) => f.type === "text");
        expect(text).toHaveLength(3);
        const [mm, dd, yy] = text;
        for (const f of text)
            expect(f).toMatchObject({
                recipient_id: "1",
                required: true,
                fixed_width: true,
                validation: "custom",
                y: 904.67,
                height: 15.33,
            });
        expect(mm).toMatchObject({
            label: "MM",
            x: 311.2,
            width: 46.67,
            validation_regex: "^(0[1-9]|1[0-2])$",
            validation_regex_error_message:
                "Enter the month as two digits, e.g. 03",
        });
        expect(dd).toMatchObject({
            label: "DD",
            x: 369.47,
            validation_regex: "^(0[1-9]|[12][0-9]|3[01])$",
        });
        expect(yy).toMatchObject({
            label: "YY",
            x: 442.67,
            width: 32,
            validation_regex: "^[0-9]{2}$",
        });
        const re = (f) => new RegExp(f.validation_regex);
        expect(
            ["01", "12"].every((v) => re(mm).test(v)) &&
                !re(mm).test("13") &&
                !re(mm).test("3")
        ).toBe(true);
        expect(
            re(dd).test("31") && !re(dd).test("32") && !re(dd).test("00")
        ).toBe(true);
        expect(re(yy).test("26") && !re(yy).test("2026")).toBe(true);
        // Pages 4 and 5 keep their locked date-signed fields.
        const locked = mapped.filter((f) => f.type === "date");
        expect(locked.map((f) => f.page).sort()).toEqual([4, 4, 5, 5]);
        expect(locked.every((f) => f.lock_sign_date)).toBe(true);
    });

    it("rejects validation on non-text fields, bad regexes and missing messages", () => {
        const base = {
            page: 1,
            kind: "signwell",
            recipient: 1,
            x: 1,
            y: 1,
            w: 10,
            h: 10,
        };
        const parse = (field) =>
            layoutSchema.safeParse({
                bundle: "p.pdf",
                fields: [
                    field,
                    { ...base, type: "signature" },
                    { ...base, recipient: 2, type: "signature" },
                ],
            }).success;
        expect(
            parse({
                ...base,
                type: "text",
                validation_regex: "^a$",
                validation_regex_error_message: "Type a",
            })
        ).toBe(true);
        expect(parse({ ...base, type: "text", validation_regex: "^a$" })).toBe(
            false
        );
        expect(
            parse({
                ...base,
                type: "text",
                validation_regex: "(",
                validation_regex_error_message: "x",
            })
        ).toBe(false);
        expect(parse({ ...base, type: "date", label: "MM" })).toBe(false);
    });
});

it("sends the requester identity and per-recipient subject/message", async () => {
    const { calls, p } = provider([
        json(201, { id: "doc_2", status: "Draft" }),
        json(201, { id: "doc_3", status: "Draft" }),
    ]);
    const withCopy = signers.map((s) => ({
        ...s,
        subject: `Subject ${s.id}`,
        message: `Message ${s.id}`,
    }));
    await p.createEnvelope(filled, withCopy, {
        ...metadata,
        requester_name: "Iron Wing Logistics L.L.C.",
        requester_email: "onboarding@example.test",
    });
    expect(calls[0].body).toMatchObject({
        custom_requester_name: "Iron Wing Logistics L.L.C.",
        custom_requester_email: "onboarding@example.test",
        reminders: false,
        recipients: [
            { id: "1", subject: "Subject 1", message: "Message 1" },
            { id: "2", subject: "Subject 2", message: "Message 2" },
        ],
    });
    // No requester email configured: the field is omitted, not null.
    await p.createEnvelope(filled, withCopy, {
        ...metadata,
        requester_name: "Iron Wing Logistics L.L.C.",
        requester_email: null,
    });
    expect(calls[1].body).not.toHaveProperty("custom_requester_email");
    expect(calls[1].body.custom_requester_name).toBe(
        "Iron Wing Logistics L.L.C."
    );
});
