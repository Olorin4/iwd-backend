/**
 * @jest-environment jsdom
 */
import fs from "node:fs";
import path from "node:path";
import { portalPage } from "../../src/onboarding/portal/views.js";
import { initialOperations } from "../../src/onboarding/readiness.js";

// The real portal.js, driven in a simulated browser: photos chosen with
// "Choose file" collect as pages (owner request 2026-11-19, desktop).
const script = fs.readFileSync(
    path.resolve("src/onboarding/portal/static/portal.js"),
    "utf8"
);
let sent;

beforeEach(() => {
    const html = portalPage(
        {
            terms: {
                legal_name: "Example Freight LLC",
                mc_number: "MC1",
                signer: { name: "Sam" },
            },
            portal_flow: true,
            operations: initialOperations(),
            signature_state: "COMPLETED",
            payment_state: "READY",
        },
        { path: "/p/fake", csrf: "c", dispatcher: null }
    );
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    URL.createObjectURL = () => "blob:fake";
    URL.revokeObjectURL = () => {};
    sent = [];
    window.XMLHttpRequest = class {
        constructor() {
            this.upload = { addEventListener() {} };
        }
        open() {}
        addEventListener() {}
        send(body) {
            sent.push(body);
        }
    };
    window.eval(script);
});

const w9 = () => document.querySelector('form[action$="/documents/W9"]');
const choose = (form, files) => {
    const input = form.querySelector(".choose input");
    Object.defineProperty(input, "files", { value: files, configurable: true });
    input.dispatchEvent(new Event("change"));
};
const image = (name) => new File(["x"], name, { type: "image/jpeg" });
const pages = (form) => form.querySelectorAll(".photo-list figure").length;
const submitButton = (form) => form.querySelector("button[type=submit]");
const addPage = (form) => form.querySelector("button.add-page");

test("photos chosen one at a time add up to pages of one PDF", () => {
    const form = w9();
    choose(form, [image("page1.jpg")]);
    expect(pages(form)).toBe(1);
    expect(submitButton(form).textContent).toBe("Send 1 page as one PDF");
    expect(addPage(form).hidden).toBe(false);
    choose(form, [image("page2.jpg")]);
    expect(pages(form)).toBe(2);
    expect(submitButton(form).textContent).toBe("Send 2 pages as one PDF");
});

test("sending uploads every collected page", () => {
    const form = w9();
    choose(form, [image("page1.jpg")]);
    choose(form, [image("page2.jpg"), image("page3.jpg")]);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0].getAll("file").map((f) => f.name)).toEqual([
        "page1.jpg",
        "page2.jpg",
        "page3.jpg",
    ]);
});

test("a PDF is still one file", () => {
    const form = w9();
    choose(form, [new File(["%PDF"], "w9.pdf", { type: "application/pdf" })]);
    expect(pages(form)).toBe(0);
    expect(submitButton(form).textContent).toBe("Upload");
    expect(form.querySelector(".chosen").textContent).toBe("Chosen: w9.pdf");
    expect(addPage(form).hidden).toBe(true);
});

test("a PDF chosen after photos is refused with the mixed-files message", () => {
    const form = w9();
    choose(form, [image("page1.jpg")]);
    choose(form, [new File(["%PDF"], "w9.pdf", { type: "application/pdf" })]);
    expect(pages(form)).toBe(1);
    expect(form.querySelector("[role=alert]").textContent).toBe(
        "Send either one PDF or photos of the pages, not both."
    );
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(sent[0].getAll("file").map((f) => f.name)).toEqual(["page1.jpg"]);
});
