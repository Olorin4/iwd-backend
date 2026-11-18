import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import {
    createFileDocumentStore,
    sha256,
} from "../../src/onboarding/documents/store";
import {
    baselineY,
    feeNumber,
    fillPacket,
    inspectPdf,
    stampValues,
} from "../../src/onboarding/documents/pdf";
import { layoutSchema } from "../../src/onboarding/documents/layout";
import {
    hexOf,
    makeBlankPages,
    makeSyntheticPacket,
    pdfStreamsText,
    syntheticLayout,
} from "./pdfFixtures";

const key = Buffer.alloc(32, 9);
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "iwd-docs-"));
const terms = {
    legal_name: "Example Freight LLC",
    dba_name: null,
    mc_number: "MC123456",
    usdot: "1234567",
    signer: {
        name: "Sam Example",
        title: "Owner",
        email: "owner@example.test",
    },
    plan: "FULL_SERVICE",
    fee_bp: 1000,
    effective_date: "2026-11-30",
    payment_methods: ["card", "us_bank_account"],
    primary_payment_method: "card",
    fleet_service_plan: null,
    truck_count: 2,
    statement_email: null,
    recipient_email: "owner@example.test",
};

describe("encrypted filesystem document store", () => {
    it("round-trips bytes, records the plaintext sha256 and never stores plaintext", async () => {
        const d = dir();
        const store = createFileDocumentStore({ dir: d, key });
        const bytes = Buffer.from("%PDF-1.7 secret contract text");
        const put = await store.put(bytes);
        expect(put.sha256).toBe(sha256(bytes));
        expect(put.size).toBe(bytes.length);
        const onDisk = fs.readFileSync(path.join(d, put.storage_key));
        expect(onDisk.includes(Buffer.from("secret contract"))).toBe(false);
        expect(
            (fs.statSync(path.join(d, put.storage_key)).mode & 0o777).toString(
                8
            )
        ).toBe("600");
        expect(
            await store.get(put.storage_key, { expectedSha256: put.sha256 })
        ).toEqual(bytes);
    });

    it("detects tampering, a wrong key, a swapped file and a hash mismatch", async () => {
        const d = dir();
        const store = createFileDocumentStore({ dir: d, key });
        const a = await store.put(Buffer.from("document A"));
        const b = await store.put(Buffer.from("document B"));
        await expect(
            store.get(a.storage_key, { expectedSha256: b.sha256 })
        ).rejects.toMatchObject({
            code: "document_hash_mismatch",
        });
        await expect(
            createFileDocumentStore({ dir: d, key: Buffer.alloc(32, 1) }).get(
                a.storage_key
            )
        ).rejects.toMatchObject({ code: "document_corrupt" });
        fs.copyFileSync(
            path.join(d, b.storage_key),
            path.join(d, a.storage_key)
        );
        await expect(store.get(a.storage_key)).rejects.toMatchObject({
            code: "document_corrupt",
        });
        const file = path.join(d, b.storage_key);
        const blob = fs.readFileSync(file);
        blob[blob.length - 1] ^= 1;
        fs.writeFileSync(file, blob);
        await expect(store.get(b.storage_key)).rejects.toMatchObject({
            code: "document_corrupt",
        });
        await expect(store.get("../etc/passwd")).rejects.toMatchObject({
            code: "invalid_storage_key",
        });
    });
});

const countersigner = {
    name: "Dispatch Lead",
    title: "Dispatch Manager",
    email: "d@example.test",
};
const releaseLayout = (version = 1) =>
    JSON.parse(
        fs.readFileSync(
            path.resolve(
                __dirname,
                `../../docs/operations/onboarding-layouts/Iron-Wing-Onboarding-Packet-v${version}.layout.json`
            ),
            "utf8"
        )
    );

describe("PDF inspection and filling", () => {
    it("refuses non-PDFs and PDFs with interactive form fields", async () => {
        await expect(inspectPdf(Buffer.from("hello"))).rejects.toMatchObject({
            code: "not_a_pdf",
        });
        await expect(
            inspectPdf(await makeSyntheticPacket({ withForm: true }))
        ).rejects.toMatchObject({
            code: "pdf_has_form_fields",
        });
        expect(
            (await inspectPdf(await makeSyntheticPacket())).pages
        ).toHaveLength(2);
    });

    it("derives stamp values from the confirmed terms and countersigner only", () => {
        expect(stampValues(terms, countersigner)).toMatchObject({
            effective_date: "November 30, 2026",
            fleet_fee_percent: null,
            fleet_service_plan: null,
            dispatch_contact_name: "Dispatch Lead, Dispatch Manager",
            carrier_contact_name: "Sam Example, Owner",
            carrier_signer_name: "Sam Example",
            start_month: "11",
            start_day: "30",
            start_year2: "26",
            statement_email: "owner@example.test",
        });
        const fleet = stampValues(
            {
                ...terms,
                plan: "FLEET",
                fee_bp: 750,
                fleet_service_plan: "ESSENTIAL",
                statement_email: "b@example.test",
            },
            countersigner
        );
        expect(fleet).toMatchObject({
            fleet_fee_percent: "7.5",
            fleet_service_plan: "Essential",
            statement_email: "b@example.test",
        });
        expect(feeNumber(1234)).toBe("12.34");
        expect(feeNumber(1000)).toBe("10");
    });

    it("converts top-left boxes to pdf-lib baselines", () => {
        expect(baselineY(792, { y: 92.2, h: 10.5 }, 10)).toBeCloseTo(
            792 - 102.7 + 2 + 0.25,
            5
        );
    });

    it("stamps values and checks as text without changing page count or existing text", async () => {
        const original = await makeSyntheticPacket();
        const layout = layoutSchema.parse(syntheticLayout());
        const [filled] = await fillPacket(
            [{ name: "packet.pdf", bytes: original }],
            layout,
            terms,
            countersigner
        );
        expect(filled.sha256).toBe(sha256(filled.bytes));
        expect(filled.fields).toHaveLength(4);
        const text = pdfStreamsText(filled.bytes);
        for (const value of [
            "Example Freight LLC",
            "MC123456",
            "1234567",
            "November 30, 2026",
            "Sam Example, Owner",
            "Dispatch Lead, Dispatch Manager",
            "owner@example.test",
        ])
            expect(text).toContain(hexOf(value));
        // FULL_SERVICE plan check and card primary check: two X marks.
        expect(text.split(hexOf("X")).length - 1).toBe(2);
        // No fleet percentage outside FLEET.
        expect(text).not.toContain(hexOf("10"));
        const doc = await PDFDocument.load(filled.bytes);
        expect(doc.getPageCount()).toBe(2);
        expect(text).toContain(hexOf("Dispatch Service Agreement"));
    });

    it("fails closed with field_overflow instead of shrinking below min_size or clipping", async () => {
        const layout = layoutSchema.parse(syntheticLayout());
        await expect(
            fillPacket(
                [{ name: "packet.pdf", bytes: await makeSyntheticPacket() }],
                layout,
                {
                    ...terms,
                    legal_name:
                        "An Extremely Long Carrier Legal Name That Cannot Fit Holdings LLC",
                },
                countersigner
            )
        ).rejects.toMatchObject({ code: "field_overflow" });
        const tooSmall = syntheticLayout();
        tooSmall.fields[0].min_size = 6;
        expect(layoutSchema.safeParse(tooSmall).success).toBe(false);
    });

    it("fails clearly for values the standard font cannot encode", async () => {
        const layout = layoutSchema.parse(syntheticLayout());
        await expect(
            fillPacket(
                [{ name: "packet.pdf", bytes: await makeSyntheticPacket() }],
                layout,
                {
                    ...terms,
                    legal_name: "Перевозчик LLC",
                },
                countersigner
            )
        ).rejects.toMatchObject({ code: "unencodable_value" });
    });

    it("requires Carrier and Dispatch signature fields in a layout", () => {
        const layout = syntheticLayout();
        layout.fields = layout.fields.filter(
            (f) => !(f.kind === "signwell" && f.recipient === 2)
        );
        expect(layoutSchema.safeParse(layout).success).toBe(false);
    });

    it("the approved release layout parses and fits the fixture terms", async () => {
        const raw = releaseLayout();
        expect(raw.status).toBe("APPROVED");
        const layout = layoutSchema.parse(raw);
        expect(layout[0].fields.length).toBeGreaterThan(30);
        const blank = await makeBlankPages(6);
        for (const t of [
            terms,
            {
                ...terms,
                plan: "FLEET",
                fee_bp: 750,
                fleet_service_plan: "FULL_SERVICE",
                truck_count: 4,
            },
        ]) {
            const [filled] = await fillPacket(
                [{ name: raw.bundle, bytes: blank }],
                layout,
                t,
                countersigner
            );
            expect(
                filled.fields.filter((f) => f.type.startsWith("signature"))
                    .length
            ).toBe(5);
        }
    });

    it("the v2 (legal name) layout is DRAFT, differs from v1 only in the page-1 opening and fits", async () => {
        const v1 = releaseLayout(1);
        const v2 = releaseLayout(2);
        expect(v2.status).toBe("DRAFT");
        expect(v2.bundle).toBe("Iron-Wing-Onboarding-Packet-v2.pdf");
        expect(v2.fields).toHaveLength(v1.fields.length);
        const changed = v2.fields
            .map((f, i) => [f, v1.fields[i]])
            .filter(([a, b]) => JSON.stringify(a) !== JSON.stringify(b))
            .map(([a]) => `${a.page}:${a.key}`);
        expect(changed.sort()).toEqual([
            "1:legal_name",
            "1:mc_number",
            "1:usdot",
        ]);
        const layout = layoutSchema.parse(v2);
        const [filled] = await fillPacket(
            [{ name: v2.bundle, bytes: await makeBlankPages(6) }],
            layout,
            terms,
            countersigner
        );
        expect(
            filled.fields.filter((f) => f.type.startsWith("signature")).length
        ).toBe(5);
    });
});
