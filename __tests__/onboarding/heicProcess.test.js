import fs from "node:fs";
import path from "node:path";
import { convertHeicIsolated } from "../../src/onboarding/files/heicProcess.js";

const heic = fs.readFileSync(
    path.resolve("__tests__/onboarding/fixtures/uploads/synthetic.heic")
);
const child = (name) =>
    path.resolve(`__tests__/onboarding/fixtures/heic-children/${name}.mjs`);

test("converts a HEIC to JPEG in a separate process", async () => {
    const jpeg = await convertHeicIsolated({
        buffer: heic,
        format: "JPEG",
        quality: 0.9,
    });
    expect(Buffer.from(jpeg).subarray(0, 3)).toEqual(
        Buffer.from("ffd8ff", "hex")
    );
}, 30000);

test("a conversion that hangs is killed at the timeout", async () => {
    const started = Date.now();
    await expect(
        convertHeicIsolated(
            { buffer: heic, format: "JPEG", quality: 0.9 },
            { script: child("hang"), timeoutMs: 500 }
        )
    ).rejects.toThrow("heic_conversion_failed");
    expect(Date.now() - started).toBeLessThan(5000);
}, 10000);

test("a child that crashes rejects, and this process keeps running", async () => {
    await expect(
        convertHeicIsolated(
            { buffer: heic, format: "JPEG", quality: 0.9 },
            { script: child("crash") }
        )
    ).rejects.toThrow("heic_conversion_failed");
    expect(process.exitCode ?? 0).toBe(0);
}, 10000);

test("conversions run one at a time", async () => {
    const options = { script: child("slow-echo") };
    const started = Date.now();
    const results = await Promise.all([
        convertHeicIsolated({ buffer: heic }, options),
        convertHeicIsolated({ buffer: heic }, options),
    ]);
    expect(results.map((r) => Buffer.from(r).length)).toEqual([
        heic.length,
        heic.length,
    ]);
    // Each child takes 300 ms; run one after the other they need ≥ 600 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(580);
}, 20000);

test("uploads use the isolated converter by default", async () => {
    const source = fs.readFileSync(
        path.resolve("src/onboarding/files/validate.js"),
        "utf8"
    );
    expect(source).toMatch(/convert = convertHeicIsolated/);
    expect(source).not.toMatch(/from "heic-convert"/);
});
