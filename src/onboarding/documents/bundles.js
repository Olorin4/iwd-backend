import { layoutSchema } from "./layout.js";
import { PdfError, inspectPdf } from "./pdf.js";

export class BundleError extends Error {
    constructor(code, detail) {
        super(detail ? `${code}: ${detail}` : code);
        this.name = "BundleError";
        this.code = code;
    }
}

function checkLayout(layout, inspected) {
    for (const file of layout.files) {
        const info = inspected[file.name];
        if (!info) throw new BundleError("layout_file_unknown", file.name);
        for (const item of [...file.stamps, ...file.fields]) {
            const page = info.pages[item.page - 1];
            if (!page)
                throw new BundleError(
                    "layout_page_out_of_range",
                    `${file.name} page ${item.page}`
                );
            if (item.x > page.width || item.y > page.height)
                throw new BundleError(
                    "layout_outside_page",
                    `${file.name} page ${item.page}`
                );
        }
    }
    for (const name of Object.keys(inspected))
        if (!layout.files.some((f) => f.name === name))
            throw new BundleError("file_without_layout", name);
}

/**
 * Registers a DRAFT bundle version. PDF bytes are stored exactly as given
 * (encrypted at rest) with their SHA-256; nothing is re-worded or rewritten.
 */
export async function registerBundle(
    db,
    store,
    { name, version, pdfs, layout }
) {
    if (!/^[a-z0-9-]{1,80}$/.test(name ?? ""))
        throw new BundleError("invalid_name");
    if (!Number.isInteger(version) || version < 1)
        throw new BundleError("invalid_version");
    const parsed = layoutSchema.safeParse(layout);
    if (!parsed.success)
        throw new BundleError(
            "invalid_layout",
            parsed.error.issues.map((i) => i.path.join(".")).join(", ")
        );
    const inspected = {};
    for (const pdf of pdfs) {
        if (inspected[pdf.name])
            throw new BundleError("duplicate_file", pdf.name);
        try {
            inspected[pdf.name] = await inspectPdf(pdf.bytes);
        } catch (error) {
            if (error instanceof PdfError)
                throw new BundleError(error.code, pdf.name);
            throw error;
        }
    }
    checkLayout(parsed.data, inspected);
    const existing = await db.documentBundleVersion.findUnique({
        where: { name_version: { name, version } },
    });
    if (existing) throw new BundleError("version_exists");
    const files = [];
    for (const pdf of pdfs) {
        const stored = await store.put(pdf.bytes);
        files.push({
            name: pdf.name,
            sha256: stored.sha256,
            size: stored.size,
            storage_key: stored.storage_key,
        });
    }
    return db.documentBundleVersion.create({
        data: { name, version, files, layout: parsed.data, status: "DRAFT" },
    });
}

/** Loads and verifies every file of a bundle version. */
export async function loadBundleFiles(store, bundle) {
    const files = [];
    for (const file of bundle.files)
        files.push({
            name: file.name,
            bytes: await store.get(file.storage_key, {
                expectedSha256: file.sha256,
            }),
        });
    return files;
}

/** DRAFT → APPROVED after re-verifying the stored files. Approved is immutable. */
export async function approveBundle(db, store, { id, by, now = new Date() }) {
    if (!by || typeof by !== "string" || by.length > 200)
        throw new BundleError("approver_required");
    const bundle = await db.documentBundleVersion.findUnique({ where: { id } });
    if (!bundle) throw new BundleError("not_found");
    if (bundle.status !== "DRAFT") throw new BundleError("not_draft");
    await loadBundleFiles(store, bundle);
    const { count } = await db.documentBundleVersion.updateMany({
        where: { id, status: "DRAFT" },
        data: { status: "APPROVED", approved_by: by, approved_at: now },
    });
    if (count !== 1) throw new BundleError("not_draft");
    return db.documentBundleVersion.findUnique({ where: { id } });
}

export async function retireBundle(db, { id }) {
    const { count } = await db.documentBundleVersion.updateMany({
        where: { id, status: "APPROVED" },
        data: { status: "RETIRED" },
    });
    if (count !== 1) throw new BundleError("not_approved");
}

export const latestApprovedBundle = (db, name) =>
    db.documentBundleVersion.findFirst({
        where: { name, status: "APPROVED" },
        orderBy: { version: "desc" },
    });
