// Synthetic packet for tests (the reviewed combined-packet.pdf has no
// reliable machine-readable coordinates in this environment). Not a test file.
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";

export async function makeSyntheticPacket({ withForm = false } = {}) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const heading of [
        "Dispatch Service Agreement",
        "Limited Power of Attorney",
    ]) {
        const page = doc.addPage([612, 792]);
        page.drawText(heading, { x: 72, y: 740, size: 14, font });
        page.drawText(
            "Effective date: ____________  Carrier: ________________",
            { x: 72, y: 700, size: 10, font }
        );
        page.drawText("MC: ________  USDOT: ________  Plan: ____________", {
            x: 72,
            y: 680,
            size: 10,
            font,
        });
        page.drawText(
            "Carrier signature: ______________   Dispatch signature: ______________",
            {
                x: 72,
                y: 120,
                size: 10,
                font,
            }
        );
    }
    if (withForm)
        doc.getForm()
            .createTextField("fee")
            .addToPage(doc.getPages()[0], { x: 10, y: 10 });
    return Buffer.from(await doc.save());
}

export async function makeBlankPages(count, size = [612, 792]) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < count; i += 1) doc.addPage(size);
    return Buffer.from(await doc.save());
}

// Same format as docs/operations/onboarding-layouts/*.layout.draft.json
// (PDF points, top-left origin).
export const syntheticLayout = (name = "packet.pdf") => ({
    bundle: name,
    status: "DRAFT",
    units: "PDF points, origin top-left of a 612x792 page",
    fields: [
        {
            page: 1,
            kind: "stamp",
            key: "effective_date",
            x: 150,
            y: 80,
            w: 120,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 1,
            kind: "stamp",
            key: "legal_name",
            x: 300,
            y: 80,
            w: 150,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 1,
            kind: "stamp",
            key: "mc_number",
            x: 95,
            y: 100,
            w: 70,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 1,
            kind: "stamp",
            key: "usdot",
            x: 190,
            y: 100,
            w: 70,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 1,
            kind: "stamp_check",
            key: "plan",
            when: "FULL_SERVICE",
            x: 60,
            y: 130,
            w: 9.4,
            h: 10.5,
        },
        {
            page: 1,
            kind: "stamp_check",
            key: "plan",
            when: "ESSENTIAL",
            x: 60,
            y: 150,
            w: 9.4,
            h: 10.5,
        },
        {
            page: 1,
            kind: "stamp",
            key: "fleet_fee_percent",
            x: 233,
            y: 170,
            w: 23,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 2,
            kind: "stamp",
            key: "carrier_contact_name",
            x: 150,
            y: 80,
            w: 200,
            h: 13,
            size: 10,
            min_size: 7,
        },
        {
            page: 2,
            kind: "stamp",
            key: "dispatch_contact_name",
            x: 150,
            y: 100,
            w: 200,
            h: 13,
            size: 10,
            min_size: 7,
        },
        {
            page: 2,
            kind: "stamp",
            key: "statement_email",
            x: 150,
            y: 120,
            w: 200,
            h: 10.5,
            size: 10,
            min_size: 7,
        },
        {
            page: 2,
            kind: "stamp_check",
            key: "primary_payment_method",
            when: "card",
            x: 60,
            y: 140,
            w: 9.4,
            h: 10.5,
        },
        {
            page: 2,
            kind: "signwell",
            recipient: 1,
            type: "signature",
            x: 170,
            y: 660,
            w: 120,
            h: 23,
        },
        {
            page: 2,
            kind: "signwell",
            recipient: 1,
            type: "date (lock_sign_date)",
            x: 170,
            y: 700,
            w: 110,
            h: 18,
        },
        {
            page: 2,
            kind: "signwell",
            recipient: 2,
            type: "signature",
            x: 400,
            y: 660,
            w: 120,
            h: 23,
        },
        {
            page: 2,
            kind: "signwell",
            recipient: 2,
            type: "date (lock_sign_date)",
            x: 400,
            y: 700,
            w: 110,
            h: 18,
        },
    ],
});

/** Decompressed text of every stream in a PDF, for asserting stamped text. */
export function pdfStreamsText(bytes) {
    const source = Buffer.from(bytes).toString("latin1");
    const parts = [];
    const re = /stream\r?\n/g;
    let match;
    while ((match = re.exec(source))) {
        const start = match.index + match[0].length;
        const end = source.indexOf("endstream", start);
        const chunk = Buffer.from(source.slice(start, end), "latin1");
        try {
            parts.push(zlib.inflateSync(chunk).toString("latin1"));
        } catch {
            parts.push(chunk.toString("latin1"));
        }
    }
    return parts.join("\n");
}

export const hexOf = (text) =>
    `<${Buffer.from(text, "latin1").toString("hex").toUpperCase()}>`;
