import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { prepareUpload } from "../../src/onboarding/files/combine.js";

const maxBytes = 15 * 1024 * 1024;
const image = (width, height, format = "jpeg") =>
    sharp({
        create: {
            width,
            height,
            channels: 3,
            background: { r: 200, g: 180, b: 90 },
        },
    })
        [format]()
        .toBuffer();
const pages = async (bytes) => (await PDFDocument.load(bytes)).getPageCount();
const pdf = Buffer.from("%PDF-1.7\nsynthetic");
const heic = fs.readFileSync(
    path.resolve("__tests__/onboarding/fixtures/uploads/synthetic.heic")
);

test("two JPEGs become one two-page PDF", async () => {
    const result = await prepareUpload(
        [await image(1200, 1600), await image(1600, 1200)],
        { maxBytes }
    );
    expect(result.ok).toBe(true);
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(await pages(result.bytes)).toBe(2);
    const doc = await PDFDocument.load(result.bytes);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 792, height: 612 });
});

test("HEIC and PNG combine", async () => {
    const result = await prepareUpload([heic, await image(800, 600, "png")], {
        maxBytes,
    });
    expect(result.ok).toBe(true);
    expect(await pages(result.bytes)).toBe(2);
});

test("a PDF with an image is refused as mixed_files", async () => {
    expect(
        await prepareUpload([pdf, await image(100, 100)], { maxBytes })
    ).toEqual({ ok: false, code: "mixed_files" });
});

test("eleven images are refused as too_many_pages", async () => {
    const one = await image(100, 100);
    expect(await prepareUpload(Array(11).fill(one), { maxBytes })).toEqual({
        ok: false,
        code: "too_many_pages",
    });
});

test("files over 15 MB in total are refused (set code)", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    big.set([0xff, 0xd8, 0xff], 0);
    expect(await prepareUpload([big, big], { maxBytes })).toEqual({
        ok: false,
        code: "too_large_set",
    });
});

test("a 6000×8000 photo combines under 15 MB", async () => {
    const huge = await sharp({
        create: {
            width: 6000,
            height: 8000,
            channels: 3,
            noise: { type: "gaussian", mean: 128, sigma: 12 },
        },
    })
        .jpeg({ quality: 85 })
        .toBuffer();
    const result = await prepareUpload([huge, await image(1000, 1000)], {
        maxBytes,
    });
    expect(result.ok).toBe(true);
    expect(result.bytes.length).toBeLessThan(maxBytes);
}, 60000);

test("a single file passes through unchanged; nothing or an unknown type is refused", async () => {
    expect(await prepareUpload([pdf], { maxBytes })).toEqual({
        ok: true,
        bytes: pdf,
    });
    expect(await prepareUpload([], { maxBytes })).toEqual({
        ok: false,
        code: "empty",
    });
    expect(
        await prepareUpload([await image(10, 10), Buffer.from("<html>")], {
            maxBytes,
        })
    ).toEqual({
        ok: false,
        code: "unsupported_type",
    });
});

test("an image larger than 50 megapixels is refused before decoding", async () => {
    const tall = await sharp({
        create: {
            width: 8000,
            height: 7000,
            channels: 3,
            background: { r: 1, g: 2, b: 3 },
        },
    })
        .jpeg()
        .toBuffer();
    expect(
        await prepareUpload([tall, await image(100, 100)], { maxBytes })
    ).toEqual({ ok: false, code: "photo_too_large" });
}, 60000);

test("a HEIC that declares more than 50 megapixels is refused without converting it", async () => {
    const { validateUpload } = await import(
        "../../src/onboarding/files/validate.js"
    );
    const bomb = Buffer.from(heic);
    const at = bomb.indexOf("ispe");
    bomb.writeUInt32BE(10000, at + 8);
    bomb.writeUInt32BE(10000, at + 12);
    const convert = jest.fn();
    expect(await validateUpload(bomb, { maxBytes, convert })).toEqual({
        ok: false,
        code: "too_large",
    });
    expect(convert).not.toHaveBeenCalled();
});

test("every declared HEIC size counts, and a HEIC without one is refused", async () => {
    const { validateUpload } = await import(
        "../../src/onboarding/files/validate.js"
    );
    const convert = jest.fn();
    // A small first size box followed by a huge one (e.g. a thumbnail first).
    const first = heic.indexOf("ispe");
    // ispe box: size, type, version/flags, width, height (20 bytes).
    const tail = Buffer.alloc(20);
    tail.writeUInt32BE(20, 0);
    tail.write("ispe", 4, "ascii");
    tail.writeUInt32BE(20000, 12);
    tail.writeUInt32BE(20000, 16);
    const second = Buffer.concat([heic, tail]);
    expect(first).toBeGreaterThan(0);
    expect(await validateUpload(second, { maxBytes, convert })).toEqual({
        ok: false,
        code: "too_large",
    });
    const none = Buffer.from(heic);
    let at;
    while ((at = none.indexOf("ispe")) > 0) none.write("xxxx", at, "ascii");
    expect(await validateUpload(none, { maxBytes, convert })).toEqual({
        ok: false,
        code: "unsupported_type",
    });
    expect(convert).not.toHaveBeenCalled();
});

test("a HEIC grid declaring a huge output or thousands of tiles is refused", async () => {
    const { validateUpload } = await import(
        "../../src/onboarding/files/validate.js"
    );
    const convert = jest.fn();
    const idat = (rowsMinusOne, colsMinusOne, width, height) => {
        // idat box: size, type, grid: version, flags(1 = 32-bit sizes), rows-1, cols-1, width, height.
        const box = Buffer.alloc(20);
        box.writeUInt32BE(20, 0);
        box.write("idat", 4, "ascii");
        box.writeUInt8(0, 8);
        box.writeUInt8(1, 9);
        box.writeUInt8(rowsMinusOne, 10);
        box.writeUInt8(colsMinusOne, 11);
        box.writeUInt32BE(width, 12);
        box.writeUInt32BE(height, 16);
        return box;
    };
    expect(
        await validateUpload(Buffer.concat([heic, idat(0, 0, 20000, 20000)]), {
            maxBytes,
            convert,
        })
    ).toEqual({
        ok: false,
        code: "too_large",
    });
    expect(
        await validateUpload(
            Buffer.concat([heic, idat(255, 255, 1000, 1000)]),
            { maxBytes, convert }
        )
    ).toEqual({
        ok: false,
        code: "too_large",
    });
    // Many tiles, each within the per-image cap, adding up past the total cap.
    const tile = Buffer.alloc(20);
    tile.writeUInt32BE(20, 0);
    tile.write("ispe", 4, "ascii");
    tile.writeUInt32BE(5000, 12);
    tile.writeUInt32BE(5000, 16);
    expect(
        await validateUpload(Buffer.concat([heic, ...Array(7).fill(tile)]), {
            maxBytes,
            convert,
        })
    ).toEqual({
        ok: false,
        code: "too_large",
    });
    expect(convert).not.toHaveBeenCalled();
});

describe("final review fixes (2026-11-19)", () => {
    test("a damaged photo in a set is refused, not a server error", async () => {
        const good = await image(800, 600);
        const truncated = good.subarray(0, Math.floor(good.length / 2));
        expect(await prepareUpload([good, truncated], { maxBytes })).toEqual({
            ok: false,
            code: "unreadable_photo",
        });
    });
    test("a set over 15 MB in total has its own code; a single file keeps too_large", async () => {
        const big = Buffer.alloc(8 * 1024 * 1024, 1);
        big.set([0xff, 0xd8, 0xff], 0);
        expect(await prepareUpload([big, big], { maxBytes })).toEqual({
            ok: false,
            code: "too_large_set",
        });
    });
    test("an image over 50 megapixels has its own code", async () => {
        const tall = await sharp({
            create: {
                width: 8000,
                height: 7000,
                channels: 3,
                background: { r: 1, g: 2, b: 3 },
            },
        })
            .jpeg()
            .toBuffer();
        expect(
            await prepareUpload([tall, await image(100, 100)], { maxBytes })
        ).toEqual({ ok: false, code: "photo_too_large" });
    }, 60000);
});
