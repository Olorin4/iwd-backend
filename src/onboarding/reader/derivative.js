import sharp from "sharp";

// Claude refuses images over 5 MB (base64 counts) and gains nothing above
// ~2000 px, while uploads may be phone photos up to 15 MB. The reader gets a
// bounded JPEG copy; the stored original is never changed. PDFs pass as is.
export const READER_MAX_EDGE = 2000;
const READER_MAX_BYTES = 3.5 * 1024 * 1024;

export async function readerInput({ bytes, mediaType }) {
    if (mediaType === "application/pdf") return { bytes, mediaType };
    const copy = await sharp(bytes, { limitInputPixels: 120_000_000 })
        .rotate()
        .resize({
            width: READER_MAX_EDGE,
            height: READER_MAX_EDGE,
            fit: "inside",
            withoutEnlargement: true,
        })
        .jpeg({ quality: 85 })
        .toBuffer();
    // Too large even when bounded: staff check it by hand (FAILED → manual).
    if (copy.length > READER_MAX_BYTES)
        throw new Error("reader_image_too_large");
    return { bytes: copy, mediaType: "image/jpeg" };
}
