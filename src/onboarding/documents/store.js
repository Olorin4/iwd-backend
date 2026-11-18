import { randomUUID } from "node:crypto";
import { open, seal, sha256, DocumentStoreError } from "../files/crypto.js";
import fs from "node:fs/promises";
import path from "node:path";

// DocumentStore port: put(bytes) → { storage_key, sha256, size };
// get(storage_key, { expectedSha256 }) → Buffer. sha256 is of the plaintext.
//
// Filesystem adapter: AES-256-GCM, one file per document under a private
// directory that is never web-served. File layout:
//   "IWD1" | 12-byte IV | 16-byte auth tag | ciphertext
// The storage key is bound as additional authenticated data, so a blob cannot
// be swapped under another key without failing authentication.

const KEY_PATTERN = /^[0-9a-f-]{36}\.bin$/;

export { sha256, DocumentStoreError };

export function createFileDocumentStore({ dir, key }) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
        throw new DocumentStoreError("invalid_key");
    const pathOf = (storageKey) => {
        if (!KEY_PATTERN.test(storageKey))
            throw new DocumentStoreError("invalid_storage_key");
        return path.join(dir, storageKey);
    };
    return {
        async delete(storageKey) {
            await fs.rm(pathOf(storageKey), { force: true });
        },
        async put(bytes) {
            const plaintext = Buffer.from(bytes);
            const storageKey = `${randomUUID()}.bin`;
            const blob = seal(key, storageKey, plaintext);
            await fs.mkdir(dir, { recursive: true, mode: 0o700 });
            const target = pathOf(storageKey);
            const temp = `${target}.tmp`;
            await fs.writeFile(temp, blob, { mode: 0o600, flag: "wx" });
            await fs.rename(temp, target);
            return {
                storage_key: storageKey,
                sha256: sha256(plaintext),
                size: plaintext.length,
            };
        },
        async get(storageKey, { expectedSha256 } = {}) {
            let blob;
            try {
                blob = await fs.readFile(pathOf(storageKey));
            } catch (error) {
                if (error instanceof DocumentStoreError) throw error;
                throw new DocumentStoreError("document_missing");
            }
            let plaintext;
            try {
                plaintext = open(key, storageKey, blob);
            } catch {
                throw new DocumentStoreError("document_corrupt");
            }
            if (expectedSha256 && sha256(plaintext) !== expectedSha256)
                throw new DocumentStoreError("document_hash_mismatch");
            return plaintext;
        },
    };
}
