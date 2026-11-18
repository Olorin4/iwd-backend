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

export const syntheticLayout = (name = "packet.pdf") => ({
    files: [
        {
            name,
            stamps: [
                { value: "effective_date", page: 1, x: 150, y: 702 },
                {
                    value: "legal_name",
                    page: 1,
                    x: 300,
                    y: 702,
                    max_width: 150,
                },
                { value: "mc_number", page: 1, x: 95, y: 682 },
                { value: "usdot", page: 1, x: 190, y: 682 },
                { value: "plan_and_fee", page: 1, x: 300, y: 682 },
                {
                    value: "mark",
                    page: 1,
                    x: 60,
                    y: 660,
                    when: { plan: ["FULL_SERVICE"] },
                },
                {
                    value: "mark",
                    page: 1,
                    x: 60,
                    y: 640,
                    when: { plan: ["ESSENTIAL"] },
                },
                { value: "payment_choice", page: 2, x: 150, y: 682 },
                { value: "signer_name_title", page: 2, x: 150, y: 702 },
            ],
            fields: [
                {
                    type: "signature",
                    recipient: "carrier",
                    page: 1,
                    x: 170,
                    y: 660,
                    width: 120,
                    height: 30,
                },
                { type: "date", recipient: "carrier", page: 1, x: 170, y: 700 },
                {
                    type: "signature",
                    recipient: "dispatch",
                    page: 1,
                    x: 400,
                    y: 660,
                    width: 120,
                    height: 30,
                },
                {
                    type: "date",
                    recipient: "dispatch",
                    page: 1,
                    x: 400,
                    y: 700,
                },
            ],
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
