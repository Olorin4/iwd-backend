import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const PERMANENT = ["src/clients", "src/onboarding", "src/payments"];

function walk(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.(c|m)?js$/.test(entry.name) ? [full] : [];
    });
}

const specifiers = (source) =>
    [
        ...source.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
        ...source.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
    ].map((m) => m[1]);

it("permanent onboarding modules never import interim billing", () => {
    const files = [
        ...PERMANENT.flatMap((dir) => walk(path.join(root, dir))),
        ...walk(path.join(root, "scripts")).filter((f) =>
            path.basename(f).startsWith("onboarding-")
        ),
    ];
    expect(files.length).toBeGreaterThanOrEqual(3);
    const offenders = files.filter((file) =>
        specifiers(fs.readFileSync(file, "utf8")).some((s) =>
            /interimBilling/.test(s)
        )
    );
    expect(offenders).toEqual([]);
});

it("no test imports src/app.js (it listens and starts interim billing)", () => {
    const tests = walk(path.join(root, "__tests__"));
    const offenders = tests.filter((file) =>
        specifiers(fs.readFileSync(file, "utf8")).some((s) => {
            if (!s.startsWith(".")) return false;
            const resolved = path.resolve(path.dirname(file), s);
            return resolved.replace(/\.js$/, "") === path.join(root, "src/app");
        })
    );
    expect(offenders).toEqual([]);
});

it("the architecture scan recognises an offending import", () => {
    expect(specifiers('import x from "../interimBilling/store.js";')).toEqual([
        "../interimBilling/store.js",
    ]);
});
