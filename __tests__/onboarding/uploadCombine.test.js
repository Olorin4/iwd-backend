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

test("files over 15 MB in total are refused as too_large", async () => {
    const big = Buffer.alloc(8 * 1024 * 1024, 1);
    big.set([0xff, 0xd8, 0xff], 0);
    expect(await prepareUpload([big, big], { maxBytes })).toEqual({
        ok: false,
        code: "too_large",
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
