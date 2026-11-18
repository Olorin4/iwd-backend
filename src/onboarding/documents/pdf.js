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

/** Page count of a PDF (throws PdfError when unreadable). */
export async function pageCount(bytes) {
    if (!Buffer.from(bytes).subarray(0, 5).equals(Buffer.from("%PDF-")))
        throw new PdfError("not_a_pdf");
    try {
        const doc = await PDFDocument.load(bytes, {
            updateMetadata: false,
            ignoreEncryption: true,
        });
        return doc.getPageCount();
    } catch {
        throw new PdfError("pdf_unreadable");
    }
}

const PLAN_LABELS = { ESSENTIAL: "Essential", FULL_SERVICE: "Full-Service" };

const formatDate = (ymd) =>
    new Date(`${ymd}T00:00:00Z`).toLocaleDateString("en-US", {
        timeZone: "UTC",
        year: "numeric",
        month: "long",
        day: "numeric",
    });

/** Basis points as a percentage number without the sign ("7.5"). */
export const feeNumber = (bp) => (bp / 100).toFixed(2).replace(/\.?0+$/, "");

/**
 * Text for each stamp key, derived only from the confirmed terms and the
 * configured countersigner. null means "leave the blank empty".
 */
export function stampValues(terms, countersigner) {
    const [year, month, day] = terms.effective_date.split("-");
    const fleet = terms.plan === "FLEET";
    return {
        effective_date: formatDate(terms.effective_date),
        legal_name: terms.legal_name,
        dba_name: terms.dba_name,
        mc_number: terms.mc_number,
        usdot: terms.usdot,
        fleet_fee_percent: fleet ? feeNumber(terms.fee_bp) : null,
        fleet_service_plan: fleet
            ? PLAN_LABELS[terms.fleet_service_plan]
            : null,
        dispatch_contact_name: `${countersigner.name}, ${countersigner.title}`,
        carrier_contact_name: `${terms.signer.name}, ${terms.signer.title}`,
        carrier_signer_name: terms.signer.name,
        start_month: month,
        start_day: day,
        start_year2: year.slice(2),
        statement_email: terms.statement_email ?? terms.recipient_email,
    };
}

export function checkMatches(field, terms) {
    if (field.key === "plan") return terms.plan === field.when;
    if (field.key === "payment_methods")
        return terms.payment_methods.includes(field.when);
    if (field.key === "primary_payment_method")
        return terms.primary_payment_method === field.when;
    return false;
}

/**
 * Baseline for text in a top-left box: the bottom of the box in pdf-lib's
 * bottom-left space, raised by the descender (0.2 em) plus half of any spare
 * box height. y_pdf = pageHeight - top - height + offset.
 */
export const baselineY = (pageHeight, f, size) =>
    pageHeight - f.y - f.h + size * 0.2 + Math.max(0, (f.h - size) / 2);

/** Largest size from `size` down to `min_size` (0.5 pt steps) that fits, else null. */
export function fitSize(font, text, f) {
    for (let size = f.size; size >= f.min_size; size -= 0.5)
        if (font.widthOfTextAtSize(text, size) <= f.w) return size;
    return null;
}

/**
 * Stamps confirmed values into each file at the layout's boxes (text only;
 * nothing existing changes). Fails closed: text that does not fit at
 * min_size raises field_overflow; nothing is shrunk below 7 pt or clipped.
 * Returns [{ name, bytes, sha256, fields }] where fields are the signwell boxes.
 */
export async function fillPacket(files, layouts, terms, countersigner) {
    const values = stampValues(terms, countersigner);
    const result = [];
    for (const layout of layouts) {
        const source = files.find((f) => f.name === layout.bundle);
        if (!source) throw new PdfError("bundle_file_missing");
        const doc = await PDFDocument.load(source.bytes, {
            updateMetadata: false,
        });
        const font = await doc.embedFont(StandardFonts.Helvetica);
        const pages = doc.getPages();
        for (const field of layout.fields) {
            if (field.kind === "signwell") continue;
            const page = pages[field.page - 1];
            if (!page) throw new PdfError("layout_page_missing");
            const { height } = page.getSize();
            try {
                if (field.kind === "stamp_check") {
                    if (!checkMatches(field, terms)) continue;
                    const size = Math.min(10, field.h);
                    const glyph = field.glyph ?? "X";
                    const x =
                        field.x +
                        (field.w - font.widthOfTextAtSize(glyph, size)) / 2;
                    page.drawText(glyph, {
                        x,
                        y: baselineY(height, field, size),
                        size,
                        font,
                        color: rgb(0, 0, 0),
                    });
                    continue;
                }
                const text = values[field.key];
                if (text === null || text === undefined || text === "")
                    continue;
                font.encodeText(text);
                const size = fitSize(font, text, field);
                if (size === null) throw new PdfError("field_overflow");
                page.drawText(text, {
                    x: field.x,
                    y: baselineY(height, field, size),
                    size,
                    font,
                    color: rgb(0, 0, 0),
                });
            } catch (error) {
                if (error instanceof PdfError) throw error;
                throw new PdfError("unencodable_value");
            }
        }
        const bytes = Buffer.from(
            await doc.save({ updateFieldAppearances: false })
        );
        result.push({
            name: layout.bundle,
            bytes,
            sha256: sha256(bytes),
            fields: layout.fields.filter((f) => f.kind === "signwell"),
        });
    }
    return result;
}
