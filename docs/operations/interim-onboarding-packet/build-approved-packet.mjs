// TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately.
// Usage: node build-approved-packet.mjs /absolute/path/to/playwright/index.mjs
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const modulePath = process.argv[2];
if (!modulePath) throw new Error("Pass a local Playwright index.mjs path.");
const directory = dirname(fileURLToPath(import.meta.url));
const approval = JSON.parse(
    await readFile(join(directory, "approved-release.json"), "utf8")
);
for (const [name, expected] of Object.entries(approval.sources)) {
    const content = await readFile(join(directory, name));
    if (createHash("sha256").update(content).digest("hex") !== expected) {
        throw new Error(
            `Approved source changed: ${name}. Review and version a new release before generating it.`
        );
    }
}
const input = await readFile(join(directory, "combined-packet.html"), "utf8");
const watermark = '<div class="review">REVIEW COPY — NOT FOR SIGNING</div>';
if (!input.includes(watermark))
    throw new Error("Expected the reviewed combined packet.");
const released = input
    .replace(watermark, "")
    .replace(
        "<title>Iron Wing onboarding — review copy</title>",
        "<title>Iron Wing Logistics L.L.C. — Onboarding Packet</title>"
    );
if (!/^Iron-Wing-Onboarding-Packet-v[0-9]+$/.test(approval.stem ?? ""))
    throw new Error(
        "approved-release.json needs a stem like Iron-Wing-Onboarding-Packet-v2."
    );
const stem = approval.stem;
const htmlPath = join(directory, `${stem}.html`);
await writeFile(htmlPath, released);
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
        if (route.request().url().startsWith("file://"))
            return route.continue();
        return route.abort();
    });
    const page = await context.newPage();
    await page.goto(pathToFileURL(htmlPath).href);
    if (await page.locator(".review").count())
        throw new Error("Review watermark remains.");
    await page.pdf({
        path: join(directory, `${stem}.pdf`),
        format: "Letter",
        preferCSSPageSize: true,
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
            '<div style="width:100%;padding:0 47px;font:8px Arial;color:#66727c;display:flex;justify-content:space-between"><span>Iron Wing Logistics L.L.C.</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    });
    await context.close();
    console.log(
        `Generated ${stem}.pdf from approved version ${approval.version}`
    );
} finally {
    await browser.close();
}
