import fs from "node:fs/promises";
import path from "node:path";
import { approveBundle, registerBundle, retireBundle } from "./bundles.js";
import { sha256 } from "./store.js";

const USAGE = `Usage:
  onboarding-bundle register --name <name> --version <n> --pdf <file.pdf> [--pdf <file.pdf>] --layout <layout.json> [--expect-sha256 <hex>]
  onboarding-bundle approve --id <bundle id> --by <approver>
  onboarding-bundle retire --id <bundle id>
  onboarding-bundle list [--name <name>]`;

export function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = { pdf: [] };
    for (let i = 0; i < rest.length; i += 2) {
        const flag = rest[i];
        const value = rest[i + 1];
        if (!flag?.startsWith("--") || value === undefined)
            throw new Error(USAGE);
        const name = flag.slice(2);
        if (name === "pdf") options.pdf.push(value);
        else options[name] = value;
    }
    return { command, options };
}

const summary = (row) => ({
    id: row.id,
    name: row.name,
    version: row.version,
    status: row.status,
    approved_by: row.approved_by,
    approved_at: row.approved_at,
    files: row.files.map((f) => ({
        name: f.name,
        sha256: f.sha256,
        size: f.size,
    })),
});

/** Runs one bundle command. Prints only ids, names and hashes. */
export async function runBundleCommand(argv, { db, store, out = console.log }) {
    const { command, options } = parseArgs(argv);
    if (command === "register") {
        if (
            !options.name ||
            !options.version ||
            options.pdf.length === 0 ||
            !options.layout
        )
            throw new Error(USAGE);
        const pdfs = [];
        for (const file of options.pdf)
            pdfs.push({
                name: path.basename(file),
                bytes: await fs.readFile(file),
            });
        const layout = JSON.parse(await fs.readFile(options.layout, "utf8"));
        const row = await registerBundle(db, store, {
            name: options.name,
            version: Number(options.version),
            pdfs,
            layout,
        });
        out(JSON.stringify(summary(row), null, 2));
        return row;
    }
    if (command === "approve") {
        if (!options.id || !options.by) throw new Error(USAGE);
        const row = await approveBundle(db, store, {
            id: options.id,
            by: options.by,
        });
        out(JSON.stringify(summary(row), null, 2));
        return row;
    }
    if (command === "retire") {
        if (!options.id) throw new Error(USAGE);
        await retireBundle(db, { id: options.id });
        out(JSON.stringify({ id: options.id, status: "RETIRED" }));
        return null;
    }
    if (command === "list") {
        const rows = await db.documentBundleVersion.findMany({
            where: options.name ? { name: options.name } : {},
            orderBy: [{ name: "asc" }, { version: "asc" }],
        });
        out(JSON.stringify(rows.map(summary), null, 2));
        return rows;
    }
    throw new Error(USAGE);
}
