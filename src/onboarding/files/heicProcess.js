import { fork } from "node:child_process";
import path from "node:path";

// HEIC decoding runs in a separate Node process (owner request 2026-11-19):
// a V8 heap cap, a hard timeout, and one conversion at a time. If the child
// runs out of memory, crashes or hangs, only the child dies; the upload is
// refused. Paths are relative to the app root (the container's WORKDIR).
const CHILD = path.resolve("src/onboarding/files/heicChild.js");
const HEAP_MB = 384;
const TIMEOUT_MS = 30000;

let queue = Promise.resolve();

function convertOnce({ buffer, format, quality }, { script, timeoutMs }) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error, bytes) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.kill("SIGKILL");
            if (error) reject(new Error("heic_conversion_failed"));
            else resolve(bytes);
        };
        const child = fork(script, [], {
            execArgv: [`--max-old-space-size=${HEAP_MB}`],
            serialization: "advanced",
            stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const timer = setTimeout(() => finish(true), timeoutMs);
        child.once("message", (message) =>
            message?.ok
                ? finish(null, Buffer.from(message.bytes))
                : finish(true)
        );
        child.once("exit", () => finish(true));
        child.once("error", () => finish(true));
        child.send({ buffer, format, quality });
    });
}

/**
 * Same interface as heic-convert's default export ({ buffer, format,
 * quality } → bytes); rejects with "heic_conversion_failed".
 */
export function convertHeicIsolated(
    { buffer, format = "JPEG", quality = 0.9 },
    { script = CHILD, timeoutMs = TIMEOUT_MS } = {}
) {
    const run = queue.then(() =>
        convertOnce({ buffer, format, quality }, { script, timeoutMs })
    );
    queue = run.catch(() => {});
    return run;
}
