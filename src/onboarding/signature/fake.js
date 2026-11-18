import { SignatureError } from "./errors.js";

// In-memory signature provider for tests and local development. Never sends
// email. Failure injection: failNext(op, mode) with mode "timeout" (no
// effect, then an ambiguous error), "timeout_after" (effect applied, then an
// ambiguous error) or "reject" (HTTP 422, no effect).
export function createFakeSignatureProvider() {
    let counter = 0;
    const documents = new Map();
    const failures = [];
    const calls = {
        createEnvelope: 0,
        send: 0,
        get: 0,
        downloadCompleted: 0,
        delete: 0,
    };
    const maybeFail = (op, effect) => {
        const index = failures.findIndex((f) => f.op === op);
        const failure = index >= 0 ? failures.splice(index, 1)[0] : null;
        if (failure?.mode === "timeout")
            throw new SignatureError("provider_timeout", { ambiguous: true });
        if (failure?.mode === "reject")
            throw new SignatureError("provider_http_422", { status: 422 });
        const result = effect();
        if (failure?.mode === "timeout_after")
            throw new SignatureError("provider_timeout", { ambiguous: true });
        return result;
    };
    const doc = (id) => {
        const found = documents.get(id);
        if (!found)
            throw new SignatureError("provider_http_404", { status: 404 });
        return found;
    };
    const setStatus = (id, status) => {
        doc(id).status = status;
    };
    return {
        name: "fake",
        documents,
        calls,
        failNext: (op, mode) => failures.push({ op, mode }),
        complete: (id) => setStatus(id, "completed"),
        decline: (id) => setStatus(id, "declined"),
        expire: (id) => setStatus(id, "expired"),
        view: (id) => setStatus(id, "viewed"),
        async createEnvelope(filled, signers, metadata) {
            calls.createEnvelope += 1;
            return maybeFail("createEnvelope", () => {
                const id = `fake_doc_${++counter}`;
                documents.set(id, {
                    id,
                    status: "draft",
                    files: filled.files,
                    signers,
                    metadata,
                    sends: 0,
                });
                return { id, status: "draft" };
            });
        },
        async send(id) {
            calls.send += 1;
            return maybeFail("send", () => {
                const d = doc(id);
                if (d.status !== "draft")
                    throw new SignatureError("provider_http_422", {
                        status: 422,
                    });
                d.status = "pending";
                d.sends += 1;
            });
        },
        async get(id) {
            calls.get += 1;
            return maybeFail("get", () => {
                const d = doc(id);
                return { id, status: d.status, metadata: d.metadata };
            });
        },
        async downloadCompleted(id) {
            calls.downloadCompleted += 1;
            return maybeFail("downloadCompleted", () => {
                if (doc(id).status !== "completed")
                    throw new SignatureError("provider_http_409", {
                        status: 409,
                    });
                return Buffer.from(
                    `%PDF-1.7\n% completed ${id} with audit page\n%%EOF\n`
                );
            });
        },
        async delete(id) {
            calls.delete += 1;
            return maybeFail("delete", () => {
                documents.delete(id);
            });
        },
    };
}
