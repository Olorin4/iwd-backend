import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { sha256 } from "./store.js";

export class PdfError extends Error {
    constructor(code) {
        super(code);
        this.name = "PdfError";
        this.code = code;
    }
}

/**
 * Checks that a PDF can be stored and later stamped without altering its
 * existing text or structure: a real, unencrypted PDF with no interactive
 * form fields (we only overlay text; filling AcroForms would change it).
 * Returns page sizes. Never modifies the bytes.
 */
export async function inspectPdf(bytes) {
    if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new PdfError("not_a_pdf");
    let doc;
    try {
        doc = await PDFDocument.load(bytes, { updateMetadata: false });
    } catch (error) {
        throw new PdfError(
            /encrypt/i.test(error?.message ?? "")
                ? "pdf_encrypted"
                : "pdf_unreadable"
        );
    }
    if (doc.isEncrypted) throw new PdfError("pdf_encrypted");
    if (doc.getForm().getFields().length > 0)
        throw new PdfError("pdf_has_form_fields");
    return { pages: doc.getPages().map((p) => p.getSize()) };
}

const PLAN_LABELS = {
    ESSENTIAL: "Essential",
    FULL_SERVICE: "Full-Service",
    CUSTOM: "Custom fleet",
};
const METHOD_LABELS = { card: "Card", us_bank_account: "ACH bank account" };

const formatDate = (ymd) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

export const feePercent = (bp) =>
    `${(bp / 100).toFixed(2).replace(/\.?0+$/, "")}%`;

/** The confirmed values a layout may stamp, derived only from the terms. */
export function stampValues(terms) {
    return {
        effective_date: formatDate(terms.effective_date),
        legal_name: terms.legal_name,
        dba_name: terms.dba_name ?? "",
        mc_number: terms.mc_number ?? "",
        usdot: terms.usdot,
        plan_label: PLAN_LABELS[terms.plan],
        fee_percent: feePercent(terms.fee_bp),
        plan_and_fee: `${PLAN_LABELS[terms.plan]} (${feePercent(terms.fee_bp)})`,
        payment_choice: terms.payment_methods
            .map((m) => METHOD_LABELS[m])
            .join(" and "),
        signer_name: terms.signer.name,
        signer_title: terms.signer.title,
        signer_name_title: `${terms.signer.name}, ${terms.signer.title}`,
        mark: "X",
    };
}

const matches = (when, terms) =>
    !when ||
    ((!when.plan || when.plan.includes(terms.plan)) &&
        (!when.payment_method ||
            terms.payment_methods.includes(when.payment_method)));

/**
 * Stamps confirmed values into each file at the layout's coordinates (text
 * only). Returns [{ name, bytes, sha256, fields }].
 */
export async function fillPacket(files, layout, terms) {
    const values = stampValues(terms);
    const result = [];
    for (const fileLayout of layout.files) {
        const source = files.find((f) => f.name === fileLayout.name);
        if (!source) throw new PdfError("bundle_file_missing");
        const doc = await PDFDocument.load(source.bytes, {
            updateMetadata: false,
        });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = doc.getPages();
        for (const stamp of fileLayout.stamps) {
            if (!matches(stamp.when, terms)) continue;
            const text = values[stamp.value];
            if (!text) continue;
            const page = pages[stamp.page - 1];
            if (!page) throw new PdfError("layout_page_missing");
            let size = stamp.size ?? 10;
            try {
                while (
                    stamp.max_width &&
                    size > 5 &&
                    font.widthOfTextAtSize(text, size) > stamp.max_width
                )
                    size -= 0.5;
                page.drawText(text, {
                    x: stamp.x,
                    y: stamp.y,
                    size,
                    font,
                    color: rgb(0, 0, 0),
                });
            } catch {
                throw new PdfError("unencodable_value");
            }
        }
        const bytes = Buffer.from(
            await doc.save({ updateFieldAppearances: false })
        );
        result.push({
            name: fileLayout.name,
            bytes,
            sha256: sha256(bytes),
            fields: fileLayout.fields,
        });
    }
    return result;
}
