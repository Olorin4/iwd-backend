import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import {
    createFileDocumentStore,
    sha256,
} from "../../src/onboarding/documents/store";
import {
    feePercent,
    fillPacket,
    inspectPdf,
    stampValues,
} from "../../src/onboarding/documents/pdf";
import { layoutSchema } from "../../src/onboarding/documents/layout";
import {
    hexOf,
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

    it("derives stamp values from the confirmed terms only", () => {
        expect(stampValues(terms)).toMatchObject({
            effective_date: "November 30, 2026",
            plan_and_fee: "Full-Service (10%)",
            payment_choice: "Card and ACH bank account",
            signer_name_title: "Sam Example, Owner",
        });
        expect(feePercent(750)).toBe("7.5%");
        expect(feePercent(1234)).toBe("12.34%");
    });

    it("stamps the values as text at the layout coordinates without changing page count", async () => {
        const original = await makeSyntheticPacket();
        const layout = layoutSchema.parse(syntheticLayout());
        const [filled] = await fillPacket(
            [{ name: "packet.pdf", bytes: original }],
            layout,
            terms
        );
        expect(filled.sha256).toBe(sha256(filled.bytes));
        expect(filled.fields).toHaveLength(4);
        const text = pdfStreamsText(filled.bytes);
        for (const value of [
            "Example Freight LLC",
            "MC123456",
            "1234567",
            "November 30, 2026",
            "Full-Service (10%)",
        ])
            expect(text).toContain(hexOf(value));
        // The plan mark is drawn for FULL_SERVICE only.
        expect(text.split(hexOf("X")).length - 1).toBe(1);
        const doc = await PDFDocument.load(filled.bytes);
        expect(doc.getPageCount()).toBe(2);
        // The original text is still there, unchanged.
        expect(text).toContain(hexOf("Dispatch Service Agreement"));
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
                }
            )
        ).rejects.toMatchObject({ code: "unencodable_value" });
    });

    it("requires Carrier and Dispatch signature fields in a layout", () => {
        const layout = syntheticLayout();
        layout.files[0].fields = layout.files[0].fields.filter(
            (f) => f.recipient === "carrier"
        );
        expect(layoutSchema.safeParse(layout).success).toBe(false);
    });
});
