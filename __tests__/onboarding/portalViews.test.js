import fs from "node:fs";
import path from "node:path";
import { portalSteps } from "../../src/onboarding/portal/steps.js";
import { portalPage, portalStamp } from "../../src/onboarding/portal/views.js";
import {
    confirmLoadBoardAccess,
    initialOperations,
    reportLoadBoard,
    verifyOperationItem,
} from "../../src/onboarding/readiness.js";

const at = new Date("2026-11-19T12:00:00Z");
const terms = {
    legal_name: "Example Freight LLC",
    mc_number: "MC123456",
    signer: { name: "Sam" },
};
const dispatcher = {
    name: "Nick Kalas",
    email: "dispatch@iron-wing-dispatching.com",
};
const received = (items, keys) =>
    items.map((i) => (keys.includes(i.key) ? { ...i, state: "RECEIVED" } : i));
const verifyAll = (items) => {
    let out = items;
    for (const key of [
        "AUTHORITY_VERIFIED",
        "INSURANCE_COI",
        "W9",
        "CARRIER_PROFILE",
        "FLEET_MAPPING",
    ])
        out = verifyOperationItem(out, key, { actor: "s", at });
    return confirmLoadBoardAccess(out, { boards: ["DAT_ONE"], actor: "s", at });
};
const row = (overrides = {}) => ({
    terms,
    portal_flow: true,
    operations: initialOperations(),
    signature_state: "SENT",
    signature_waiting_for: "CARRIER",
    payment_state: "NOT_STARTED",
    provisioning_state: "NOT_STARTED",
    cancelled_at: null,
    ...overrides,
});
const page = (r, options = {}) =>
    portalPage(r, { path: "/p/fake", csrf: "c", dispatcher, ...options });
const openCount = (html) => (html.match(/<details[^>]*\bopen\b/g) ?? []).length;
const states = (r) => portalSteps(r).steps.map((s) => `${s.id}:${s.state}`);

describe("portalSteps", () => {
    test("unsigned: sign is current, the rest upcoming", () => {
        expect(states(row())).toEqual([
            "sign:current",
            "payment:upcoming",
            "documents:upcoming",
            "loadBoard:upcoming",
            "about:optional",
        ]);
        expect(portalSteps(row()).doneCount).toBe(0);
    });
    test("signed and paid: documents is current", () => {
        const r = row({ signature_state: "COMPLETED", payment_state: "READY" });
        expect(states(r).slice(0, 3)).toEqual([
            "sign:done",
            "payment:done",
            "documents:current",
        ]);
        expect(portalSteps(r).doneCount).toBe(2);
    });
    test("documents count as done when W-9, insurance and authority are in (factoring optional)", () => {
        const r = row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            operations: received(initialOperations(), [
                "W9",
                "INSURANCE_COI",
                "AUTHORITY_VERIFIED",
            ]),
        });
        expect(states(r)[2]).toBe("documents:done");
        expect(states(r)[3]).toBe("loadBoard:current");
    });
    test("all four done but not READY: phase allSet and no current step", () => {
        const operations = confirmLoadBoardAccess(
            received(initialOperations(), [
                "W9",
                "INSURANCE_COI",
                "AUTHORITY_VERIFIED",
            ]),
            { boards: ["DAT_ONE"], actor: "s", at }
        );
        const r = row({
            signature_state: "COMPLETED",
            payment_state: "PENDING_VERIFICATION",
            operations,
        });
        const model = portalSteps(r);
        expect(model.phase).toBe("allSet");
        expect(model.doneCount).toBe(4);
        expect(model.steps.some((s) => s.state === "current")).toBe(false);
    });
    test("READY and cancelled phases", () => {
        const ready = row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            provisioning_state: "MANUAL_CONFIRMED",
            operations: verifyAll(initialOperations()),
        });
        expect(portalSteps(ready).phase).toBe("ready");
        expect(portalSteps(row({ cancelled_at: at })).phase).toBe("closed");
    });
});

describe("portal page", () => {
    test("header counts done steps and only the current step is open", () => {
        const html = page(
            row({ signature_state: "COMPLETED", payment_state: "READY" })
        );
        expect(html).toContain("2 of 4 steps done");
        expect(openCount(html)).toBe(1);
        expect(html).toMatch(
            /<details[^>]*\bopen\b[^>]*>[\s\S]*?You are here[\s\S]*?Upload your documents/
        );
        expect(html).toContain("step-done");
        expect(html).toContain("Card");
    });
    test("all set card when the carrier is done but Iron Wing is still reviewing", () => {
        const operations = confirmLoadBoardAccess(
            received(initialOperations(), [
                "W9",
                "INSURANCE_COI",
                "AUTHORITY_VERIFIED",
            ]),
            { boards: ["DAT_ONE"], actor: "s", at }
        );
        const html = page(
            row({
                signature_state: "COMPLETED",
                payment_state: "READY",
                operations,
            })
        );
        expect(html).toContain("4 of 4 steps done");
        expect(html).toContain(
            "All set on your side. Iron Wing is reviewing your documents and setting up your account — you’ll see You’re ready here when we’re done. Nothing else to do."
        );
        expect(openCount(html)).toBe(0);
    });
    test("ready hero replaces the steps' focus", () => {
        const html = page(
            row({
                signature_state: "COMPLETED",
                payment_state: "READY",
                provisioning_state: "MANUAL_CONFIRMED",
                operations: verifyAll(initialOperations()),
            })
        );
        expect(html).toMatch(/class="ready-hero"[\s\S]*You’re ready/);
        expect(html).toContain("Download your signed agreement");
        expect(html).toContain("This page stays available for 30 days.");
    });
    test("factoring row is optional and has no 'I don't factor' button", () => {
        const html = page(
            row({ signature_state: "COMPLETED", payment_state: "READY" })
        );
        expect(html).toMatch(
            /Factoring notice[\s\S]*Optional[\s\S]*Only if you use a factoring company/
        );
        expect(html).not.toContain("/not-factoring");
        expect(html).not.toMatch(/don.t factor/i);
    });
    test("each document row offers a multi-file chooser and a camera-only 'Take photos'", () => {
        const html = page(
            row({ signature_state: "COMPLETED", payment_state: "READY" })
        );
        expect(html).toMatch(/<input[^>]*name="file"[^>]*multiple/);
        expect(html).toMatch(
            /class="take-photos"[\s\S]*?capture="environment"/
        );
        const css = fs.readFileSync(
            path.resolve("src/onboarding/portal/static/portal.css"),
            "utf8"
        );
        expect(css).toMatch(
            /@media \(hover: none\) and \(pointer: coarse\)[\s\S]*?\.take-photos/
        );
    });
    test("load board boards show confirmed vs waiting, with the official guides", () => {
        let operations = reportLoadBoard(initialOperations(), {
            board: "DAT_ONE",
            at,
        });
        operations = confirmLoadBoardAccess(operations, {
            boards: ["DAT_ONE"],
            actor: "s",
            at,
        });
        operations = reportLoadBoard(operations, { board: "TRUCKSTOP", at });
        const html = page(
            row({
                signature_state: "COMPLETED",
                payment_state: "READY",
                operations,
            })
        );
        expect(html).toMatch(/DAT One[\s\S]*?Confirmed by Iron Wing/);
        expect(html).toMatch(
            /Truckstop[\s\S]*?Added · waiting for Iron Wing to confirm/
        );
        const guide = page(
            row({ signature_state: "COMPLETED", payment_state: "READY" })
        );
        expect(guide).toContain(
            'href="https://one.support.dat.com/en/account-billing-84e74143/user-management-f41a4be0/add-a-new-user-and-purchase-a-new-seat-0c787870"'
        );
        expect(guide).toContain(
            'href="https://community.truckstop.com/s/article/Account-Management-Tool"'
        );
        expect(guide).toContain("Official DAT guide ↗");
        expect(guide).toContain("Official Truckstop guide ↗");
    });
    test("after pressing Added the step says it waits for Iron Wing", () => {
        const operations = reportLoadBoard(initialOperations(), {
            board: "DAT_ONE",
            at,
        });
        const html = page(
            row({
                signature_state: "COMPLETED",
                payment_state: "READY",
                operations,
            }),
            {
                query: { board: "added" },
            }
        );
        expect(html).toContain(
            "You added a seat on DAT One for Nick Kalas. Waiting for Iron Wing to confirm access — it will show a green check here."
        );
    });
    test("reasons and names are escaped", () => {
        const operations = initialOperations().map((i) =>
            i.key === "W9"
                ? {
                      ...i,
                      state: "REUPLOAD_REQUESTED",
                      note: "<script>x</script>",
                  }
                : i
        );
        const html = page(
            row({
                signature_state: "COMPLETED",
                payment_state: "READY",
                operations,
                terms: { ...terms, legal_name: "<b>Bad</b> LLC" },
            })
        );
        expect(html).not.toContain("<script>x</script>");
        expect(html).toContain("&lt;script&gt;x&lt;/script&gt;");
        expect(html).not.toContain("<b>Bad</b>");
    });
});

describe("final review fixes (2026-11-19)", () => {
    const readyWithFactoringRedo = () => {
        let operations = verifyAll(initialOperations());
        operations = operations.map((i) =>
            i.key === "FACTORING_NOA"
                ? {
                      ...i,
                      state: "REUPLOAD_REQUESTED",
                      note: "Wrong factoring company.",
                  }
                : i
        );
        return row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            provisioning_state: "MANUAL_CONFIRMED",
            operations,
        });
    };
    test("a re-upload request opens the documents step and is announced, even when READY", () => {
        const html = page(readyWithFactoringRedo());
        expect(html).toMatch(/<details open>[\s\S]*?Wrong factoring company\./);
        expect(html).toContain(
            "Iron Wing asked for a new file — see your documents below."
        );
        expect(html).not.toContain("All verified ✓");
    });
    test("error messages for photo sets", () => {
        const base = row({
            signature_state: "COMPLETED",
            payment_state: "READY",
        });
        expect(page(base, { query: { error: "too_large_set" } })).toContain(
            "Together these photos are over 15 MB — send fewer pages or upload a PDF."
        );
        expect(page(base, { query: { error: "unreadable_photo" } })).toContain(
            "One of the photos couldn’t be read. Take it again or upload a PDF."
        );
        expect(page(base, { query: { error: "photo_too_large" } })).toContain(
            "A photo is too large to read. Take it again at a normal size or upload a PDF."
        );
    });
    test("without JavaScript the native file input stays visible; scripts show chosen files and check the total size", () => {
        const css = fs.readFileSync(
            path.resolve("src/onboarding/portal/static/portal.css"),
            "utf8"
        );
        expect(css).toMatch(/\.js \.choose input,[\s\S]*?\{[^}]*opacity: 0/);
        // The unscoped rule must not hide the input.
        expect(css).not.toMatch(
            /(^|\n)\.choose input,\s*\n\.take-photos input\s*\{[^}]*opacity/
        );
        const js = fs.readFileSync(
            path.resolve("src/onboarding/portal/static/portal.js"),
            "utf8"
        );
        expect(js).toContain('document.documentElement.classList.add("js")');
        expect(js).toMatch(/files? chosen/);
        expect(js).toContain("Together these photos are over 15 MB");
    });
});

test("busy message", () => {
    expect(
        page(row({ signature_state: "COMPLETED", payment_state: "READY" }), {
            query: { error: "busy" },
        })
    ).toContain(
        "We’re busy reading photos right now. Please try again in a minute."
    );
});

test("a received document can be replaced until Iron Wing verifies it", () => {
    const html = page(
        row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            operations: received(initialOperations(), ["W9"]),
        })
    );
    const w9 = html.slice(
        html.indexOf("W-9"),
        html.indexOf("</li>", html.indexOf("W-9"))
    );
    expect(w9).toMatch(
        /<details class="replace"><summary>Replace this document<\/summary>/
    );
    expect(w9).toContain("Send the whole document again, with every page.");
    expect(w9).toContain('action="/p/fake/documents/W9"');
    const verified = page(
        row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            operations: verifyOperationItem(
                received(initialOperations(), ["W9"]),
                "W9",
                { actor: "s", at }
            ),
        })
    );
    const v = verified.slice(
        verified.indexOf("W-9"),
        verified.indexOf("</li>", verified.indexOf("W-9"))
    );
    expect(v).not.toContain("Replace this document");
});

test("the page fingerprint changes with what the carrier sees, not with bookkeeping", () => {
    const base = row({
        signature_state: "COMPLETED",
        payment_state: "READY",
        operations: received(initialOperations(), ["W9"]),
    });
    const stamp = portalStamp(base);
    expect(stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(page(base)).toContain(`data-stamp="${stamp}"`);
    expect(
        portalStamp({
            ...base,
            portal_last_opened_at: at,
            reminders_sent: 2,
            version: 9,
        })
    ).toBe(stamp);
    expect(
        portalStamp({
            ...base,
            operations: verifyOperationItem(base.operations, "W9", {
                actor: "s",
                at,
            }),
        })
    ).not.toBe(stamp);
    expect(portalStamp({ ...base, cancelled_at: at })).not.toBe(stamp);
    expect(portalStamp({ ...base, dispatcher_name: "Other" })).not.toBe(stamp);
});

describe("document card colours (owner 2026-11-19)", () => {
    const docsRow = (operations) =>
        row({
            signature_state: "COMPLETED",
            payment_state: "READY",
            operations,
        });
    const card = (html, label) => {
        const start = html.lastIndexOf("<li", html.indexOf(label));
        return html.slice(start, html.indexOf("</li>", start));
    };
    const w9File = (flags) => ({
        id: "d1",
        item_key: "W9",
        flags,
        extraction_status: "DONE",
    });

    test("received but not verified is an in-review card, not green", () => {
        const html = page(docsRow(received(initialOperations(), ["W9"])), {
            ownFiles: [w9File([])],
        });
        expect(card(html, "W-9")).toMatch(/class="doc doc-review"/);
        expect(card(html, "W-9")).toContain(
            "Received — Iron Wing is reviewing it"
        );
    });

    test("only verified is green", () => {
        const ops = verifyOperationItem(
            received(initialOperations(), ["W9"]),
            "W9",
            { actor: "s", at }
        );
        expect(card(page(docsRow(ops)), "W-9")).toMatch(/class="doc doc-done"/);
    });

    test("a file the reader flagged is orange, says why and opens Replace", () => {
        const html = page(docsRow(received(initialOperations(), ["W9"])), {
            ownFiles: [w9File(["name_mismatch", "signature_missing"])],
        });
        const w9 = card(html, "W-9");
        expect(w9).toMatch(/class="doc doc-redo"/);
        expect(w9).toContain(
            "Please check: the company name doesn’t seem to match Example Freight LLC; the form doesn’t look signed."
        );
        expect(w9).toContain('<details class="replace" open>');
    });

    test("a flagged file opens the documents step even when everything was sent", () => {
        const ops = received(initialOperations(), [
            "W9",
            "INSURANCE_COI",
            "AUTHORITY_VERIFIED",
        ]);
        const quiet = page(docsRow(ops), { ownFiles: [w9File([])] });
        const flagged = page(docsRow(ops), {
            ownFiles: [w9File(["unreadable"])],
        });
        const docsOpen = (html) =>
            /<details open>(?:(?!<\/details>)[\s\S])*?Documents sent|<details open>(?:(?!<\/details>)[\s\S])*?Upload your documents/.test(
                html
            );
        expect(docsOpen(quiet)).toBe(false);
        expect(docsOpen(flagged)).toBe(true);
    });

    test("verified stays green even if the reader had flagged it", () => {
        const ops = verifyOperationItem(
            received(initialOperations(), ["W9"]),
            "W9",
            { actor: "s", at }
        );
        const html = page(docsRow(ops), {
            ownFiles: [w9File(["name_mismatch"])],
        });
        expect(card(html, "W-9")).toMatch(/class="doc doc-done"/);
    });

    test("an operator re-upload request is orange", () => {
        const ops = initialOperations().map((i) =>
            i.key === "W9"
                ? { ...i, state: "REUPLOAD_REQUESTED", note: "Page 2 missing" }
                : i
        );
        expect(card(page(docsRow(ops)), "W-9")).toMatch(/class="doc doc-redo"/);
    });

    test("the fingerprint follows the reader's flags", () => {
        const r = docsRow(received(initialOperations(), ["W9"]));
        expect(portalStamp(r, [w9File([])])).not.toBe(
            portalStamp(r, [w9File(["name_mismatch"])])
        );
        expect(page(r, { ownFiles: [w9File(["unreadable"])] })).toContain(
            `data-stamp="${portalStamp(r, [w9File(["unreadable"])])}"`
        );
    });
});
