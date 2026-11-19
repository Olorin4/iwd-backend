import { fork } from "node:child_process";
import path from "node:path";

// HEIC decoding runs in a separate Node process (owner request 2026-11-19):
// a V8 heap cap, a hard timeout, and one conversion at a time. If the child
// runs out of memory, crashes or hangs, only the child dies; the upload is
// refused. Paths are relative to the app root (the container's WORKDIR).
const CHILD = path.resolve("src/onboarding/files/heicChild.js");
const HEAP_MB = 384;
const TIMEOUT_MS = 15000;
// One running plus at most three waiting; more is refused as busy instead of
// letting a burst of slow files hold everyone else's uploads.
const MAX_WAITING = 3;

let queue = Promise.resolve();
let pending = 0;

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
    if (pending > MAX_WAITING) return Promise.reject(new Error("heic_busy"));
    pending += 1;
    const run = queue
        .then(() =>
            convertOnce({ buffer, format, quality }, { script, timeoutMs })
        )
        .finally(() => {
            pending -= 1;
        });
    queue = run.catch(() => {});
    return run;
}
