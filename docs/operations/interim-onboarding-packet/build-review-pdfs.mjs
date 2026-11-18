// TEMPORARY: manual bridge until permanent onboarding is available. Retain executed client records privately.
// Usage: node build-review-pdfs.mjs /absolute/path/to/playwright/index.mjs
import { resolve, dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const modulePath = process.argv[2];
if (!modulePath) {
    throw new Error(
        "Pass the absolute path to an installed Playwright index.mjs. No dependency installation or network access is performed."
    );
}
const { chromium } = await import(pathToFileURL(resolve(modulePath)).href);
const directory = dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext();
    await context.route("**/*", (route) => {
        if (route.request().url().startsWith("file://"))
            return route.continue();
        return route.abort();
    });
    const page = await context.newPage();
    for (const name of [
        "dispatch-service-agreement",
        "limited-power-of-attorney",
        "payment-authorization-form",
        "combined-packet",
    ]) {
        const input = join(directory, `${name}.html`);
        await access(input);
        await page.goto(pathToFileURL(input).href);
        const watermark = await page.locator(".review").innerText();
        if (watermark !== "REVIEW COPY — NOT FOR SIGNING") {
            throw new Error(
                "This builder only generates watermarked review copies."
            );
        }
        await page.pdf({
            path: join(directory, `${name}.pdf`),
            format: "Letter",
            preferCSSPageSize: true,
            printBackground: true,
            displayHeaderFooter: true,
            headerTemplate: "<span></span>",
            footerTemplate:
                '<div style="width:100%;padding:0 47px;font:8px Arial;color:#66727c;display:flex;justify-content:space-between"><span>Iron Wing Logistics L.L.C. · Review copy · 2026-11-18</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
        });
        console.log(`Generated ${name}.pdf`);
    }
    await context.close();
} finally {
    await browser.close();
}
