jest.mock("nodemailer", () => ({
    createTransport: jest.fn(),
}));

const nodemailer = require("nodemailer");

// Loads emailService afresh with the given SMTP settings and returns it with
// the transport options it was created with and its sendMail mock.
function load(env = {}) {
    const sendMail = jest.fn().mockResolvedValue({ messageId: "x" });
    nodemailer.createTransport.mockReset();
    nodemailer.createTransport.mockReturnValue({ sendMail });
    Object.assign(process.env, {
        EMAIL_HOST: "smtp.example.com",
        EMAIL_PORT: "587",
        EMAIL_USER: "info@example.com",
        EMAIL_PASS: "secret",
        ...env,
    });
    let service;
    jest.isolateModules(() => {
        service = require("../src/emailService");
    });
    return {
        service,
        sendMail,
        options: nodemailer.createTransport.mock.calls[0][0],
    };
}

describe("emailService transport", () => {
    it("checks the mail server's certificate", () => {
        const { options } = load();
        expect(options.tls?.rejectUnauthorized).not.toBe(false);
        expect(options.tls?.ciphers).toBeUndefined();
    });

    it("refuses to send the password without encryption on port 587", () => {
        const { options } = load({ EMAIL_PORT: "587" });
        expect(options.port).toBe(587);
        expect(options.secure).toBe(false);
        expect(options.requireTLS).toBe(true);
    });

    it("uses implicit TLS on port 465", () => {
        const { options } = load({ EMAIL_PORT: "465" });
        expect(options.secure).toBe(true);
    });

    it("leaves console.log working", () => {
        const before = console.log;
        load();
        expect(console.log).toBe(before);
    });
});

describe("emailClient", () => {
    it("sends replies to the business mailbox, not back to the recipient", async () => {
        const { service, sendMail } = load();
        await service.emailClient("carrier@example.com", "Hi", "Hello");
        const mail = sendMail.mock.calls[0][0];
        expect(mail.to).toBe("carrier@example.com");
        expect(mail.from).toBe("info@example.com");
        expect(mail.replyTo).not.toBe("carrier@example.com");
    });

    it("keeps line breaks and paragraphs in the HTML", async () => {
        const { service, sendMail } = load();
        await service.emailClient(
            "carrier@example.com",
            "Hi",
            "Hello Ann,\n\nThank you.\nSee you soon."
        );
        const { html, text } = sendMail.mock.calls[0][0];
        expect(html).toContain("<p>Hello Ann,</p>");
        expect(html).toContain("<p>Thank you.<br>See you soon.</p>");
        expect(text).toContain("Hello Ann,\n\nThank you.\nSee you soon.");
    });

    it("escapes HTML in the text it is given", async () => {
        const { service, sendMail } = load();
        await service.emailClient(
            "carrier@example.com",
            "Hi",
            "Hello O'Brien <script>x</script> & co"
        );
        const { html } = sendMail.mock.calls[0][0];
        expect(html).toContain(
            "O&#39;Brien &lt;script&gt;x&lt;/script&gt; &amp; co"
        );
        expect(html).not.toContain("<script>");
    });

    it("rejects an invalid recipient", async () => {
        const { service, sendMail } = load();
        await expect(
            service.emailClient("not-an-email", "Hi", "Hello")
        ).rejects.toThrow("Invalid recipient");
        expect(sendMail).not.toHaveBeenCalled();
    });
});

describe("emailAdmin", () => {
    it("sends to the business mailbox and can set who a reply goes to", async () => {
        const { service, sendMail } = load();
        await service.emailAdmin("New sign-up", "Name: Ann", {
            replyTo: "carrier@example.com",
        });
        const mail = sendMail.mock.calls[0][0];
        expect(mail.to).toBe("info@example.com");
        expect(mail.replyTo).toBe("carrier@example.com");
    });

    it("ignores an invalid reply-to address", async () => {
        const { service, sendMail } = load();
        await service.emailAdmin("New sign-up", "Name: Ann", {
            replyTo: "bad\r\nBcc: x@example.com",
        });
        expect(sendMail.mock.calls[0][0].replyTo).toBeUndefined();
    });
});

describe("signature", () => {
    it("matches the Zoho Mail signature in the HTML", async () => {
        const { service, sendMail } = load();
        await service.emailClient("carrier@example.com", "Hi", "Hello");
        const { html, attachments } = sendMail.mock.calls[0][0];
        expect(html).toContain("Best");
        expect(html).toContain("Nick Kalas");
        expect(html).toContain("Manager");
        expect(html).toContain(
            '<a href="https://iron-wing-dispatching.com" target="_blank">Iron Wing Logistics L.L.C.</a>'
        );
        expect(html).toContain("phone: +1 (817) 865-3016");
        expect(html).toContain('href="https://iron-wing-dispatching.com"');
        expect(html).toContain('src="cid:companyLogo"');
        expect(html).not.toMatch(/linkedin/i);
        expect(attachments.map((a) => a.cid)).toEqual(["companyLogo"]);
    });

    it("ends the plain-text part with the same signature", async () => {
        const { service, sendMail } = load();
        await service.emailClient("carrier@example.com", "Hi", "Hello");
        const { text } = sendMail.mock.calls[0][0];
        expect(text).toBe(
            "Hello\n\nBest\n\nNick Kalas\nManager\nIron Wing Logistics L.L.C.\nhttps://iron-wing-dispatching.com\nphone: +1 (817) 865-3016"
        );
    });
});

describe("sendEmail attachments", () => {
    // The exact message interim billing and the forms send today (they never
    // pass attachments). Must stay byte-identical.
    const interimShaped = {
        from: "support@example.com",
        to: "admin@example.com",
        subject: "Run summary",
        text: "Line one\n\nLine two",
    };

    it("leaves callers without attachments unchanged", async () => {
        const { service, sendMail } = load();
        await service.sendEmail({ ...interimShaped });
        const mail = sendMail.mock.calls[0][0];
        expect(Object.keys(mail).sort()).toEqual(
            ["attachments", "from", "html", "subject", "text", "to"].sort()
        );
        expect(mail.attachments).toEqual([
            {
                filename: "logo.jpg",
                path: "src/assets/logo.jpg",
                cid: "companyLogo",
            },
        ]);
        expect(mail.from).toBe("support@example.com");
        expect(mail.to).toBe("admin@example.com");
        expect(mail.subject).toBe("Run summary");
        expect(mail.text.startsWith("Line one\n\nLine two\n\nBest\n\n")).toBe(
            true
        );
        expect(mail.html).toContain("<p>Line one</p>\n<p>Line two</p>");
    });

    it("adds extra attachments after the logo", async () => {
        const { service, sendMail } = load();
        const pdf = {
            filename: "a.pdf",
            content: Buffer.from("%PDF"),
            contentType: "application/pdf",
        };
        await service.sendEmail({ ...interimShaped, attachments: [pdf] });
        const { attachments } = sendMail.mock.calls[0][0];
        expect(attachments.map((a) => a.cid ?? a.filename)).toEqual([
            "companyLogo",
            "a.pdf",
        ]);
        expect(attachments[1]).toBe(pdf);
    });
});

describe("sendEmail html", () => {
    const base = {
        from: "support@example.com",
        to: "admin@example.com",
        subject: "Run summary",
        text: "Line one\n\nLine two",
    };

    it("without html sends exactly what it always did", async () => {
        const a = load();
        await a.service.sendEmail({ ...base });
        const b = load();
        await b.service.sendEmail({ ...base, html: undefined });
        const plain = a.sendMail.mock.calls[0][0];
        expect(b.sendMail.mock.calls[0][0]).toEqual(plain);
        expect(
            plain.html.startsWith("<p>Line one</p>\n<p>Line two</p>\n")
        ).toBe(true);
        expect(Object.keys(plain)).not.toContain("htmlBody");
    });

    it("uses the given html body, then the signature and logo as before", async () => {
        const { service, sendMail } = load();
        await service.sendEmail({ ...base, html: "<p>Custom</p>" });
        const mail = sendMail.mock.calls[0][0];
        expect(mail.html.startsWith("<p>Custom</p>\n")).toBe(true);
        expect(mail.html).not.toContain("Line one");
        expect(mail.html).toContain('src="cid:companyLogo"');
        expect(mail.text.startsWith("Line one\n\nLine two\n\nBest\n\n")).toBe(
            true
        );
        expect(mail.attachments.map((x) => x.cid)).toEqual(["companyLogo"]);
        expect(Object.keys(mail).sort()).toEqual(
            ["attachments", "from", "html", "subject", "text", "to"].sort()
        );
    });
});
