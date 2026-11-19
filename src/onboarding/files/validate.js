import { convertHeicIsolated } from "./heicProcess.js";

const signatures = [
    [Buffer.from("%PDF-"), "application/pdf"],
    [Buffer.from("ffd8ff", "hex"), "image/jpeg"],
    [Buffer.from("89504e470d0a1a0a", "hex"), "image/png"],
];

export async function validateUpload(
    bytes,
    { maxBytes, convert = convertHeicIsolated }
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
    if (heicTooLarge(bytes)) return { ok: false, code: "too_large" };
    if (!declaredSizes(bytes).length)
        return { ok: false, code: "unsupported_type" };
    try {
        const jpeg = Buffer.from(
            await convert({ buffer: bytes, format: "JPEG", quality: 0.9 })
        );
        if (jpeg.length > maxBytes) return { ok: false, code: "too_large" };
        if (jpeg.subarray(0, 3).equals(signatures[1][0]))
            return { ok: true, bytes: jpeg, mediaType: "image/jpeg" };
    } catch (error) {
        if (error?.message === "heic_busy") return { ok: false, code: "busy" };
        // Malformed HEIC files use the same public error as unsupported files.
    }
    return { ok: false, code: "unsupported_type" };
}

// HEIC decompression-bomb limits, read from the file's boxes before any
// decode: every declared image size ("ispe", required for each image item,
// grids and tiles included) ≤ 50 MP; their total ≤ 150 MP (a 48 MP iPhone
// photo is about 100 MP of tiles + grid + thumbnail); a grid ("idat")
// output ≤ 50 MP from at most 512 tiles.
const MAX_IMAGE_PIXELS = 50_000_000;
const MAX_TOTAL_PIXELS = 150_000_000;
const MAX_TILES = 512;

function declaredSizes(bytes) {
    const sizes = [];
    for (
        let at = bytes.indexOf("ispe");
        at > 0 && at + 16 <= bytes.length;
        at = bytes.indexOf("ispe", at + 4)
    )
        sizes.push(bytes.readUInt32BE(at + 8) * bytes.readUInt32BE(at + 12));
    return sizes;
}

function heicTooLarge(bytes) {
    const sizes = declaredSizes(bytes);
    if (sizes.some((size) => size > MAX_IMAGE_PIXELS)) return true;
    if (sizes.reduce((sum, size) => sum + size, 0) > MAX_TOTAL_PIXELS)
        return true;
    for (
        let at = bytes.indexOf("idat");
        at > 0 && at + 8 <= bytes.length;
        at = bytes.indexOf("idat", at + 4)
    ) {
        const wide = (bytes[at + 5] & 1) === 1;
        const end = at + 8 + (wide ? 8 : 4);
        if (end > bytes.length) continue;
        const tiles = (bytes[at + 6] + 1) * (bytes[at + 7] + 1);
        const width = wide
            ? bytes.readUInt32BE(at + 8)
            : bytes.readUInt16BE(at + 8);
        const height = wide
            ? bytes.readUInt32BE(at + 12)
            : bytes.readUInt16BE(at + 10);
        if (tiles > MAX_TILES || width * height > MAX_IMAGE_PIXELS) return true;
    }
    return false;
}
