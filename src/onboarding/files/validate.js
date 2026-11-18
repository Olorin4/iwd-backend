import convertHeic from "heic-convert";

const signatures = [
    [Buffer.from("%PDF-"), "application/pdf"],
    [Buffer.from("ffd8ff", "hex"), "image/jpeg"],
    [Buffer.from("89504e470d0a1a0a", "hex"), "image/png"],
];

export async function validateUpload(
    bytes,
    { maxBytes, convert = convertHeic }
) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0)
        return { ok: false, code: "empty" };
    if (bytes.length > maxBytes) return { ok: false, code: "too_large" };
    for (const [magic, mediaType] of signatures)
        if (bytes.subarray(0, magic.length).equals(magic))
            return { ok: true, bytes, mediaType };
    if (
        !["ftypheic", "ftypheix", "ftypmif1"].includes(
            bytes.toString("ascii", 4, 12)
        )
    )
        return { ok: false, code: "unsupported_type" };
    try {
        const jpeg = Buffer.from(
            await convert({ buffer: bytes, format: "JPEG", quality: 0.9 })
        );
        if (jpeg.length > maxBytes) return { ok: false, code: "too_large" };
        if (jpeg.subarray(0, 3).equals(signatures[1][0]))
            return { ok: true, bytes: jpeg, mediaType: "image/jpeg" };
    } catch {
        // Malformed HEIC files use the same public error as unsupported files.
    }
    return { ok: false, code: "unsupported_type" };
}
