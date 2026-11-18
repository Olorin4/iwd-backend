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
import {
    initialOperations,
    missingCarrierSlots,
    operationsState,
    requestReupload,
    unverifyOperationItem,
    verifyOperationItem,
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
