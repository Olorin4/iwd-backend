import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { validateUpload } from "./validate.js";

// Owner ruling 2026-11-19: a carrier may photograph each page of a
// document; up to 10 images become one PDF before the normal upload checks.
export const MAX_PAGES = 10;
const LETTER = [612, 792];
const MARGIN = 36;
const MAX_EDGE = 2000;
// Refuse decompression bombs before decoding (phone photos are ≤ ~50 MP).
export const MAX_PIXELS = 50_000_000;
const fail = (code) => ({ ok: false, code });

/**
 * files: Buffer[] (non-empty parts of one document post). One file passes
 * through unchanged (recordUpload validates it). Several must all be
 * images: each is bounded (≤2000 px, JPEG q85) and placed on its own US
 * Letter page (landscape when wider than tall), scaled to fit.
 */
export async function prepareUpload(files, { maxBytes }) {
    if (!files.length) return fail("empty");
    if (files.length === 1) return { ok: true, bytes: files[0] };
    if (files.length > MAX_PAGES) return fail("too_many_pages");
    if (files.reduce((sum, f) => sum + f.length, 0) > maxBytes)
        return fail("too_large_set");
    const images = [];
    for (const file of files) {
        const checked = await validateUpload(file, { maxBytes });
        if (!checked.ok) return checked;
        if (checked.mediaType === "application/pdf") return fail("mixed_files");
        images.push(checked.bytes);
    }
    const pdf = await PDFDocument.create();
    for (const bytes of images) {
        let meta;
        try {
            // Header only (no pixel decode), so the size is read safely.
            meta = await sharp(bytes, { limitInputPixels: false }).metadata();
        } catch {
            return fail("unsupported_type");
        }
        if (!meta.width || !meta.height) return fail("unreadable_photo");
        if (meta.width * meta.height > MAX_PIXELS)
            return fail("photo_too_large");
    }
    // A damaged photo (e.g. a truncated JPEG) passes the header checks but
    // fails to decode: refuse it plainly instead of a server error.
    try {
        for (const bytes of images) {
            const jpeg = await sharp(bytes, { limitInputPixels: MAX_PIXELS })
                .rotate()
                .resize({
                    width: MAX_EDGE,
                    height: MAX_EDGE,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .jpeg({ quality: 85 })
                .toBuffer();
            const image = await pdf.embedJpg(jpeg);
            const [w, h] =
                image.width > image.height ? [LETTER[1], LETTER[0]] : LETTER;
            const scale = Math.min(
                (w - 2 * MARGIN) / image.width,
                (h - 2 * MARGIN) / image.height
            );
            const page = pdf.addPage([w, h]);
            page.drawImage(image, {
                x: (w - image.width * scale) / 2,
                y: (h - image.height * scale) / 2,
                width: image.width * scale,
                height: image.height * scale,
            });
        }
    } catch {
        return fail("unreadable_photo");
    }
    const bytes = Buffer.from(await pdf.save());
    return bytes.length > maxBytes
        ? fail("too_large_set")
        : { ok: true, bytes };
}
