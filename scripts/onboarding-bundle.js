// Document bundle administration for client onboarding (design §8).
// Registers reviewed PDFs unchanged (encrypted at rest, SHA-256 recorded) as a
// DRAFT version, and lets the owner approve it. Approved versions are
// immutable; new wording is a new version.
//
//   node -r dotenv/config scripts/onboarding-bundle.js register --name iron-wing-carrier-client \
//       --version 1 --pdf combined-packet.pdf --layout layout.json
//   node -r dotenv/config scripts/onboarding-bundle.js approve --id <id> --by "<owner name>"
//
// Needs DB_URL, ONBOARDING_DOCUMENT_DIR and ONBOARDING_DOCUMENT_KEY.
import { prisma } from "../src/prismaClient.js";
import { parseDocumentKey } from "../src/onboarding/config.js";
import { createFileDocumentStore } from "../src/onboarding/documents/store.js";
import { runBundleCommand } from "../src/onboarding/documents/cli.js";

try {
    if (!process.env.ONBOARDING_DOCUMENT_DIR)
        throw new Error("ONBOARDING_DOCUMENT_DIR is required.");
    const store = createFileDocumentStore({
        dir: process.env.ONBOARDING_DOCUMENT_DIR,
        key: parseDocumentKey(process.env.ONBOARDING_DOCUMENT_KEY),
    });
    await runBundleCommand(process.argv.slice(2), { db: prisma, store });
    process.exitCode = 0;
} catch (error) {
    console.error(
        error.code ? `${error.code}: ${error.message}` : error.message
    );
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
