// Child process for HEIC → JPEG conversion (see heicProcess.js). A crafted
// HEIC can make the decoder use huge memory or run for a long time; here it
// can only take this process down, never the app.
import convert from "heic-convert";

process.on("message", async ({ buffer, format, quality }) => {
    try {
        const output = await convert({
            buffer: Buffer.from(buffer),
            format,
            quality,
        });
        process.send({ ok: true, bytes: Buffer.from(output) });
    } catch {
        process.send({ ok: false });
    }
});
