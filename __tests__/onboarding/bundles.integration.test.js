import fs from "node:fs";
import path from "node:path";
import { prisma } from "../../src/prismaClient";
import { createFileDocumentStore } from "../../src/onboarding/documents/store";
import { runBundleCommand } from "../../src/onboarding/documents/cli";
import {
    latestApprovedBundle,
    loadBundleFiles,
} from "../../src/onboarding/documents/bundles";
import { makeSyntheticPacket, syntheticLayout } from "./pdfFixtures";
import { tempDir } from "./harness";

const NAME = "test-bundle-cli";
let dir, store, out;

beforeEach(async () => {
    // Approved rows are immutable by trigger; tests use a unique name and
    // remove only their own rows by disabling the trigger for this session.
    await prisma.$executeRawUnsafe(
        `ALTER TABLE "document_bundle_version" DISABLE TRIGGER "document_bundle_version_guard"`
    );
    await prisma.documentBundleVersion.deleteMany({
        where: { name: { startsWith: NAME } },
    });
    await prisma.$executeRawUnsafe(
        `ALTER TABLE "document_bundle_version" ENABLE TRIGGER "document_bundle_version_guard"`
    );
    dir = tempDir();
    store = createFileDocumentStore({
        dir: path.join(dir, "store"),
        key: Buffer.alloc(32, 3),
    });
    out = jest.fn();
});

async function files() {
    const pdf = path.join(dir, "packet.pdf");
    fs.writeFileSync(pdf, await makeSyntheticPacket());
    const layout = path.join(dir, "layout.json");
    fs.writeFileSync(layout, JSON.stringify(syntheticLayout()));
    return { pdf, layout };
}

it("registers a DRAFT with the exact PDF bytes, approves it, and then it is immutable", async () => {
    const { pdf, layout } = await files();
    const draft = await runBundleCommand(
        [
            "register",
            "--name",
            NAME,
            "--version",
            "1",
            "--pdf",
            pdf,
            "--layout",
            layout,
        ],
        { db: prisma, store, out }
    );
    expect(draft.status).toBe("DRAFT");
    const [stored] = await loadBundleFiles(store, draft);
    expect(stored.bytes.equals(fs.readFileSync(pdf))).toBe(true);
    expect(await latestApprovedBundle(prisma, NAME)).toBeNull();

    const approved = await runBundleCommand(
        ["approve", "--id", draft.id, "--by", "Owner Name"],
        {
            db: prisma,
            store,
            out,
        }
    );
    expect(approved).toMatchObject({
        status: "APPROVED",
        approved_by: "Owner Name",
    });
    expect((await latestApprovedBundle(prisma, NAME)).id).toBe(draft.id);
    expect(out.mock.calls.join("\n")).not.toContain("storage_key");

    await expect(
        prisma.documentBundleVersion.update({
            where: { id: draft.id },
            data: { layout: {} },
        })
    ).rejects.toThrow();
    await expect(
        prisma.documentBundleVersion.delete({ where: { id: draft.id } })
    ).rejects.toThrow();
    await expect(
        runBundleCommand(["approve", "--id", draft.id, "--by", "x"], {
            db: prisma,
            store,
            out,
        })
    ).rejects.toMatchObject({ code: "not_draft" });
    await expect(
        runBundleCommand(
            [
                "register",
                "--name",
                NAME,
                "--version",
                "1",
                "--pdf",
                pdf,
                "--layout",
                layout,
            ],
            {
                db: prisma,
                store,
                out,
            }
        )
    ).rejects.toMatchObject({ code: "version_exists" });
});

it("refuses PDFs it would have to alter and layouts outside the pages", async () => {
    const { layout } = await files();
    const formPdf = path.join(dir, "packet.pdf");
    fs.writeFileSync(formPdf, await makeSyntheticPacket({ withForm: true }));
    await expect(
        runBundleCommand(
            [
                "register",
                "--name",
                NAME,
                "--version",
                "2",
                "--pdf",
                formPdf,
                "--layout",
                layout,
            ],
            {
                db: prisma,
                store,
                out,
            }
        )
    ).rejects.toMatchObject({ code: "pdf_has_form_fields" });
    fs.writeFileSync(formPdf, await makeSyntheticPacket());
    const bad = syntheticLayout();
    bad.files[0].stamps[0].page = 9;
    fs.writeFileSync(layout, JSON.stringify(bad));
    await expect(
        runBundleCommand(
            [
                "register",
                "--name",
                NAME,
                "--version",
                "2",
                "--pdf",
                formPdf,
                "--layout",
                layout,
            ],
            {
                db: prisma,
                store,
                out,
            }
        )
    ).rejects.toMatchObject({ code: "layout_page_out_of_range" });
});
