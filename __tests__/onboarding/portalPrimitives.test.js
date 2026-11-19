import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
    createPortalToken,
    parsePortalToken,
} from "../../src/onboarding/portal/token.js";
import { createR2DocumentStore } from "../../src/onboarding/files/r2Store.js";
import { validateUpload } from "../../src/onboarding/files/validate.js";
import {
    stripTinLike,
    w9Schema,
    DOCUMENT_SCHEMAS,
} from "../../src/onboarding/reader/schemas.js";
import { computeFlags } from "../../src/onboarding/reader/flags.js";
import { extractDocument } from "../../src/onboarding/reader/claude.js";
import sharp from "sharp";
import {
    initialOperations,
    missingCarrierSlots,
    operationsState,
    requestReupload,
    unverifyOperationItem,
    verifyOperationItem,
    confirmLoadBoardAccess,
} from "../../src/onboarding/readiness.js";
import {
    invitationEmail,
    portalReminderEmail,
    reuploadEmail,
} from "../../src/onboarding/portalEmails.js";
import { portalPage } from "../../src/onboarding/portal/views.js";
import { questionnaireSchema } from "../../src/onboarding/questionnaire.js";
import { onboardingStatusV1 } from "../../src/onboarding/contracts.js";
import { fixture } from "./harness.js";

const maxBytes = 15 * 1024 * 1024;
const actor = { user_id: "closer", email: "closer@example.test" };
const at = new Date("2026-11-18T12:00:00Z");
const terms = {
    legal_name: "Harbor Freight L.L.C.",
    signer: { name: "Test Signer" },
    mc_number: "MC123456",
    usdot: "1234567",
};

test("portal token round trip rejects tampering, extra segments and oversized input", () => {
    const id = randomBytes(16).toString("base64url");
    const token = createPortalToken("secret", id);
    expect(parsePortalToken("secret", token)).toEqual({ tokenId: id });
    for (const invalid of [
        token + ".extra",
        token.replace(/.$/, token.endsWith("0") ? "1" : "0"),
        "x".repeat(500),
    ])
        expect(parsePortalToken("secret", invalid)).toEqual({
            error: "invalid",
        });
});

test("R2 seals content with IWD1, verifies hashes and binds the ciphertext to its key", async () => {
    const objects = new Map();
    const client = {
        async send(command) {
            const { Key, Body } = command.input;
            switch (command.constructor.name) {
                case "PutObjectCommand":
                    objects.set(Key, Body);
                    return;
                case "GetObjectCommand":
                    return {
                        Body: {
                            transformToByteArray: () =>
                                Promise.resolve(objects.get(Key)),
                        },
                    };
                case "DeleteObjectCommand":
                    objects.delete(Key);
                    return;
                default:
                    throw new Error("Unexpected R2 command");
            }
        },
    };
    const store = createR2DocumentStore({
        client,
        bucket: "test",
        key: Buffer.alloc(32, 7),
    });
    const file = Buffer.from("test file");
    const result = await store.put(file);
    const stored = objects.get(result.storage_key);
    expect(stored.subarray(0, 4).toString()).toBe("IWD1");
    expect(stored.includes(file)).toBe(false);
    await expect(
        store.get(result.storage_key, { expectedSha256: result.sha256 })
    ).resolves.toEqual(file);
    await expect(
        store.get(result.storage_key, { expectedSha256: "wrong" })
    ).rejects.toMatchObject({ code: "integrity_failed" });
    const other = await store.put(file);
    objects.set(other.storage_key, stored);
    await expect(store.get(other.storage_key)).rejects.toMatchObject({
        code: "integrity_failed",
    });
    await store.delete(result.storage_key);
    expect(objects.has(result.storage_key)).toBe(false);
});

test.each([
    ["255044462d312e37", "application/pdf"],
    ["ffd8ffe000", "image/jpeg"],
    ["89504e470d0a1a0a", "image/png"],
])("recognises magic bytes %s as %s", async (magic, mediaType) => {
    const bytes = Buffer.from(magic, "hex");
    await expect(validateUpload(bytes, { maxBytes })).resolves.toEqual({
        ok: true,
        bytes,
        mediaType,
    });
});

test("rejects HTML or SVG masquerading as PDF and enforces the inclusive 15 MB byte limit", async () => {
    for (const markup of [
        "<html><script>test</script></html>",
        "<svg xmlns='http://www.w3.org/2000/svg'/>",
    ])
        await expect(
            validateUpload(Buffer.from(markup), { maxBytes })
        ).resolves.toEqual({ ok: false, code: "unsupported_type" });
    const exact = Buffer.alloc(maxBytes);
    exact.write("%PDF-");
    await expect(validateUpload(exact, { maxBytes })).resolves.toMatchObject({
        ok: true,
        mediaType: "application/pdf",
    });
    await expect(
        validateUpload(Buffer.alloc(maxBytes + 1), { maxBytes })
    ).resolves.toEqual({ ok: false, code: "too_large" });
    await expect(
        validateUpload(Buffer.alloc(0), { maxBytes })
    ).resolves.toEqual({ ok: false, code: "empty" });
});

test("converts a real HEIC file to JPEG and refuses a malformed HEIC", async () => {
    const bytes = fs.readFileSync(
        path.join(__dirname, "fixtures/uploads/synthetic.heic")
    );
    const result = await validateUpload(bytes, { maxBytes });
    expect(result).toMatchObject({ ok: true, mediaType: "image/jpeg" });
    expect(result.bytes.subarray(0, 3)).toEqual(Buffer.from("ffd8ff", "hex"));
    await expect(
        validateUpload(Buffer.from("1234ftypheic"), { maxBytes })
    ).resolves.toMatchObject({ ok: false });
});

test("re-upload requires a reason and remains outstanding; undo verify returns to received", () => {
    const pending = initialOperations();
    const verified = verifyOperationItem(pending, "W9", { actor, at });
    expect(unverifyOperationItem(pending, "W9", { actor, at })).toBeNull();
    const received = unverifyOperationItem(verified, "W9", { actor, at });
    expect(received.find((i) => i.key === "W9").state).toBe("RECEIVED");
    expect(() =>
        requestReupload(received, "W9", { note: "", actor, at })
    ).toThrow("invalid_reupload_reason");
    const returned = requestReupload(received, "W9", {
        note: "Try a clearer copy",
        actor,
        at,
    });
    expect(returned.find((i) => i.key === "W9")).toMatchObject({
        state: "REUPLOAD_REQUESTED",
        note: "Try a clearer copy",
    });
    expect(missingCarrierSlots(returned)).toContain("W9");
    expect(operationsState(returned)).toBe("PENDING");
});

test("removes full TIN-shaped strings and numbers from nested extraction", () => {
    expect(
        stripTinLike({
            address: "tax 123-45-6789",
            name: "12-3456789",
            n: 123456789,
            nested: { tax: "123456789", last: "7890" },
        })
    ).toEqual({
        address: null,
        name: null,
        n: null,
        nested: { tax: null, last: "7890" },
    });
    expect(w9Schema.shape.tin_last4.safeParse("123456789").success).toBe(false);
    // Dotted and spaced TINs go; ZIP+4 codes and phone numbers stay.
    expect(
        stripTinLike({
            dotted: "TIN 123.45.6789",
            spaced: "12 3456789",
            mixed: "123-45 6789",
            partial: "123-456789",
            bareZip: "12345-6789",
            zip: "Dallas, TX 75201-4567",
            phone: "(214) 555-0199",
        })
    ).toEqual({
        dotted: null,
        spaced: null,
        mixed: null,
        partial: null,
        // Without a state code before it, a 5-4 number may be a TIN: removed.
        bareZip: null,
        zip: "Dallas, TX 75201-4567",
        phone: "(214) 555-0199",
    });
});

test("flags wrong type, insurance expiry and normalized carrier name", () => {
    const extracted = {
        document_type_matches: false,
        named_insured: "Harbor Freight LLC",
        policies: [
            { expiry_date: "2026-12-08" },
            { expiry_date: "2026-11-17" },
        ],
    };
    expect(computeFlags("INSURANCE_COI", extracted, terms, at)).toEqual([
        "wrong_document_type",
        "insurance_expired",
        "insurance_expiring_30d",
    ]);
    expect(
        computeFlags(
            "AUTHORITY_VERIFIED",
            { legal_name: "Other Co", mc_number: "MC555", usdot: "999" },
            terms,
            at
        )
    ).toEqual(["name_mismatch", "mc_mismatch", "usdot_mismatch"]);
});

test("Anthropic structured-output helper accepts every schema and the W-9 prompt forbids full TIN output", async () => {
    const parse = jest
        .fn()
        .mockResolvedValue({ parsed_output: { test: true } });
    for (const key of Object.keys(DOCUMENT_SCHEMAS))
        await extractDocument(
            { client: { messages: { parse } }, model: "fake" },
            key,
            { bytes: Buffer.from("fixture"), mediaType: "application/pdf" }
        );
    const call = parse.mock.calls[0][0];
    expect(call.output_config.format.type).toBe("json_schema");
    expect(call.messages[0].content[0]).toMatchObject({ type: "document" });
    expect(call.messages[0].content[1].text).toMatch(/Never output a full TIN/);
});

test("a large photo reaches the reader as a bounded JPEG; the stored original is untouched", async () => {
    const original = await sharp({
        create: {
            width: 6000,
            height: 4000,
            channels: 3,
            noise: { type: "gaussian", mean: 128, sigma: 40 },
        },
    })
        .png()
        .toBuffer();
    expect(original.length).toBeGreaterThan(5 * 1024 * 1024);
    const copy = Buffer.from(original);
    const parse = jest.fn().mockResolvedValue({
        stop_reason: "end_turn",
        parsed_output: { document_type_matches: true },
    });
    await extractDocument(
        { client: { messages: { parse } }, model: "fake" },
        "INSURANCE_COI",
        {
            bytes: original,
            mediaType: "image/png",
        }
    );
    const block = parse.mock.calls[0][0].messages[0].content[0];
    expect(block).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
    });
    const sent = Buffer.from(block.source.data, "base64");
    expect(sent.length).toBeLessThan(3.5 * 1024 * 1024);
    const meta = await sharp(sent).metadata();
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(2000);
    expect(original.equals(copy)).toBe(true);
}, 30000);

test("a PDF is sent to the reader unchanged", async () => {
    const parse = jest.fn().mockResolvedValue({
        stop_reason: "end_turn",
        parsed_output: { document_type_matches: true },
    });
    const bytes = Buffer.from("%PDF-1.7 synthetic");
    await extractDocument(
        { client: { messages: { parse } }, model: "fake" },
        "W9",
        { bytes, mediaType: "application/pdf" }
    );
    expect(parse.mock.calls[0][0].messages[0].content[0].source.data).toBe(
        bytes.toString("base64")
    );
});

test("portal email copy uses one portal link, exact subjects and an escaped action button", () => {
    const url = "https://portal.example.test/p/synthetic";
    const invite = invitationEmail({ terms, url });
    const reminder = portalReminderEmail({
        terms,
        url,
        missing: ["Sign your agreement"],
    });
    const reupload = reuploadEmail({
        terms,
        url,
        itemLabel: "W-9 form",
        reason: "<clearer copy>",
    });
    expect(invite.subject).toBe(
        "Your Iron Wing onboarding page — Harbor Freight L.L.C."
    );
    expect(reminder.subject).toBe(
        "Reminder: your Iron Wing onboarding — Harbor Freight L.L.C."
    );
    expect(reupload.subject).toBe(
        "Please upload a new W-9 form — Harbor Freight L.L.C."
    );
    for (const email of [invite, reminder, reupload]) {
        expect(email.text.split("\n")).toContain(url);
        expect(email.text).not.toMatch(
            /[{}]|https:\/\/(?:www\.)?(?:signwell|stripe)\./i
        );
        expect(email.html).toContain("Open your onboarding page");
    }
    expect(reupload.html).toContain("&lt;clearer copy&gt;");
});

test("renders escaped carrier names and re-upload reasons", () => {
    const operations = initialOperations().map((item) =>
        item.key === "W9"
            ? { ...item, state: "REUPLOAD_REQUESTED", note: "<please retry>" }
            : item
    );
    const page = portalPage(
        {
            terms: { ...terms, legal_name: "<script>bad</script>" },
            operations,
            signature_state: "COMPLETED",
            payment_state: "READY",
        },
        { path: "/p/fake", csrf: "test" }
    );
    expect(page).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(page).toContain("&lt;please retry&gt;");
    expect(page).not.toContain("<script>bad</script>");
});

test("puts separate dispatcher seat instructions between documents and the questionnaire", () => {
    const row = {
        terms,
        operations: initialOperations(),
        signature_state: "COMPLETED",
    };
    const options = { path: "/p/fake", csrf: "test" };
    const page = portalPage(row, options);
    expect(page).toMatch(
        /③[^<]*<\/span> Documents[\s\S]+④[^<]*<\/span> Set up load board access[\s\S]+⑤[^<]*<\/span> About your operation/
    );
    expect(page).toContain("account.dat.com");
    expect(page).toContain("Seat Assignments");
    expect(page).toContain("Subscriptions &amp; Users");
    expect(page).toContain("Manage Users");
    expect(page).not.toMatch(/type="password"/);
    expect(
        portalPage({ ...row, signature_state: "SENT" }, options)
    ).not.toContain("account.dat.com");
    expect(
        portalPage({ ...row, cancelled_at: new Date() }, options)
    ).not.toContain("account.dat.com");
});

test("portal pages keep their own header and footer: legal name, one contact, no site chrome", () => {
    const page = portalPage(
        {
            terms,
            operations: initialOperations(),
            signature_state: "SENT",
        },
        { path: "/p/fake" }
    );
    const header = page.match(/<header\b[\s\S]*?<\/header>/)?.[0];
    expect(header).toContain('class="brand"');
    expect(header).toContain('src="/portal-static/logo.svg?v=1"');
    expect(header).toContain("Iron Wing Logistics L.L.C.");
    const footer = page.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
    expect(footer).toBe(
        '<footer>Questions? Reply to our email or write to <a href="mailto:onboarding@iron-wing-dispatching.com">onboarding@iron-wing-dispatching.com</a>.</footer>'
    );
    for (const gone of [
        "iron-wing-dispatching.com/#",
        "newsletter",
        "facebook",
        "hamburger",
        "/portal-static/iron-wing/",
        "info@iron-wing",
        "Iron Wing Dispatching",
    ])
        expect(page).not.toContain(gone);
});

test("questionnaire accepts omitted values and rejects zero trucks", () => {
    expect(
        questionnaireSchema.parse({
            home_base: "Athens",
            equipment_types: "Reefer",
            min_rate_per_load: "",
        })
    ).toMatchObject({
        home_base: "Athens",
        equipment_types: ["Reefer"],
        min_rate_per_load: null,
        truck_count: null,
    });
    expect(questionnaireSchema.safeParse({ truck_count: "0" }).success).toBe(
        false
    );
});

test("both original and portal status fixtures validate", () => {
    expect(
        onboardingStatusV1.parse(fixture("onboarding.status.v1")).portal
    ).toBeUndefined();
    expect(
        onboardingStatusV1.parse(fixture("onboarding.status.v1.portal")).portal
            .flow
    ).toBe(true);
});

test("portal paths are recognised and redacted in any case", async () => {
    const { isPortalPath } = await import(
        "../../src/onboarding/portal/hostGuard.js"
    );
    const { redactedPortalPath } = await import(
        "../../src/onboarding/portal/routes.js"
    );
    for (const path of ["/p/abc", "/P/abc/documents/W9", "/p?x=1", "/p"])
        expect(isPortalPath(path)).toBe(true);
    for (const path of ["/pa", "/portal-static/portal.css", "/onboarding/p/x"])
        expect(isPortalPath(path)).toBe(false);
    expect(redactedPortalPath("/p/SECRET/documents/W9?uploaded=W9")).toBe(
        "/p/[token]/documents/W9"
    );
    expect(redactedPortalPath("/P/SECRET")).toBe("/p/[token]");
    expect(redactedPortalPath("/p/SECRET/%2e%2e/odd path")).toBe("/p/[token]");
    for (const url of ["/P/SECRET/x", "/p/SECRET#frag", "/p/SECRET/a/../b"])
        expect(redactedPortalPath(url)).not.toContain("SECRET");
});

test("SignWell gets send_email false for a recipient that must get no email", async () => {
    const { signwellRecipient } = await import(
        "../../src/onboarding/signature/signwell.js"
    );
    expect(
        signwellRecipient({
            id: "1",
            name: "Sam",
            email: "sam@example.test",
            sendEmail: false,
        })
    ).toEqual({
        id: "1",
        name: "Sam",
        email: "sam@example.test",
        send_email: false,
    });
    expect(
        signwellRecipient({ id: "2", name: "Iw", email: "iw@example.test" })
            .send_email
    ).toBe(true);
});

test("load board access is a staff-confirmed checklist item that READY waits for", () => {
    const items = initialOperations();
    expect(items.find((i) => i.key === "LOAD_BOARD_ACCESS")).toMatchObject({
        state: "PENDING",
    });
    expect(missingCarrierSlots(items)).not.toContain("LOAD_BOARD_ACCESS");
    let all = items;
    for (const item of items.filter((i) => i.key !== "LOAD_BOARD_ACCESS"))
        all = verifyOperationItem(all, item.key, { actor: "s", at });
    expect(operationsState(all)).toBe("PENDING");
    const confirmed = confirmLoadBoardAccess(all, {
        boards: ["DAT_ONE", "OTHER"],
        note: "123Loadboard",
        actor: "s",
        at,
    });
    expect(confirmed.find((i) => i.key === "LOAD_BOARD_ACCESS")).toMatchObject({
        state: "VERIFIED",
        boards: ["DAT_ONE", "OTHER"],
        note: "123Loadboard",
    });
    expect(operationsState(confirmed)).toBe("COMPLETE");
    const undone = unverifyOperationItem(confirmed, "LOAD_BOARD_ACCESS", {
        actor: "s",
        at,
    });
    const reopened = undone.find((i) => i.key === "LOAD_BOARD_ACCESS");
    expect(reopened.state).toBe("PENDING");
    expect(reopened.boards).toBeUndefined();
    expect(() =>
        confirmLoadBoardAccess(all, { boards: [], actor: "s", at })
    ).toThrow();
    expect(() =>
        confirmLoadBoardAccess(all, { boards: ["OTHER"], actor: "s", at })
    ).toThrow();
});

test("requests from before load board tracking stay complete with their six items", () => {
    let legacy = initialOperations().filter(
        (i) => i.key !== "LOAD_BOARD_ACCESS"
    );
    for (const item of legacy)
        legacy = verifyOperationItem(legacy, item.key, { actor: "s", at });
    expect(legacy).toHaveLength(6);
    expect(operationsState(legacy)).toBe("COMPLETE");
});

test("a READY onboarding opens with 'You're ready'; at least one load board is asked for", () => {
    let operations = initialOperations();
    for (const item of operations.filter((i) => i.key !== "LOAD_BOARD_ACCESS"))
        operations = verifyOperationItem(operations, item.key, {
            actor: "s",
            at,
        });
    const inProgress = {
        terms,
        operations,
        signature_state: "COMPLETED",
        payment_state: "READY",
        provisioning_state: "MANUAL_CONFIRMED",
    };
    let page = portalPage(inProgress, { path: "/p/fake" });
    expect(page).not.toContain("You’re ready");
    expect(page).toContain(
        "Set up at least one load board: DAT One, Truckstop or another board you use. You can add more than one."
    );
    const ready = {
        ...inProgress,
        operations: confirmLoadBoardAccess(operations, {
            boards: ["TRUCKSTOP"],
            actor: "s",
            at,
        }),
    };
    page = portalPage(ready, { path: "/p/fake" });
    expect(page).toMatch(
        /<section class="card ready"[^>]*>[\s\S]*You’re ready/
    );
    expect(page.indexOf("You’re ready")).toBeLessThan(
        page.indexOf("Sign your agreement")
    );
    expect(page).toContain("Iron Wing confirmed access to Truckstop");
    expect(
        portalPage({ ...ready, cancelled_at: new Date() }, { path: "/p/fake" })
    ).not.toContain("You’re ready");
});

describe("factoring is optional for portal onboardings only (2026-11-19)", () => {
    const allButFactoring = () => {
        let items = initialOperations();
        for (const key of [
            "AUTHORITY_VERIFIED",
            "INSURANCE_COI",
            "W9",
            "CARRIER_PROFILE",
            "FLEET_MAPPING",
        ])
            items = verifyOperationItem(items, key, { actor: "s", at });
        return confirmLoadBoardAccess(items, {
            boards: ["DAT_ONE"],
            actor: "s",
            at,
        });
    };
    test.each([
        ["PENDING", (items) => items],
        [
            "RECEIVED",
            (items) =>
                items.map((i) =>
                    i.key === "FACTORING_NOA" ? { ...i, state: "RECEIVED" } : i
                ),
        ],
        [
            "REUPLOAD_REQUESTED",
            (items) =>
                items.map((i) =>
                    i.key === "FACTORING_NOA"
                        ? { ...i, state: "REUPLOAD_REQUESTED", note: "x" }
                        : i
                ),
        ],
        [
            "NOT_FACTORING RECEIVED",
            (items) =>
                items.map((i) =>
                    i.key === "FACTORING_NOA"
                        ? { ...i, key: "NOT_FACTORING", state: "RECEIVED" }
                        : i
                ),
        ],
    ])("portal operations complete with factoring %s", (_, shape) => {
        expect(
            operationsState(shape(allButFactoring()), { portal: true })
        ).toBe("COMPLETE");
    });
    test("email-flow operations stay PENDING while factoring is PENDING", () => {
        expect(operationsState(allButFactoring())).toBe("PENDING");
    });
    test("portal reminders never list factoring", async () => {
        const { portalMissingSteps } = await import(
            "../../src/onboarding/portalFlow.js"
        );
        const steps = portalMissingSteps({
            terms,
            operations: initialOperations(),
            signature_state: "COMPLETED",
            payment_state: "READY",
        });
        expect(steps.join(" | ")).not.toMatch(/factoring/i);
        expect(steps).toContain("W-9 form");
    });
});
