import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
    randomUUID,
} from "node:crypto";
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

const MAGIC = Buffer.from("IWD1");
const KEY_PATTERN = /^[0-9a-f-]{36}\.bin$/;

export class DocumentStoreError extends Error {
    constructor(code) {
        super(code);
        this.name = "DocumentStoreError";
        this.code = code;
    }
}

export const sha256 = (bytes) =>
    createHash("sha256").update(bytes).digest("hex");

export function createFileDocumentStore({ dir, key }) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
        throw new DocumentStoreError("invalid_key");
    const pathOf = (storageKey) => {
        if (!KEY_PATTERN.test(storageKey))
            throw new DocumentStoreError("invalid_storage_key");
        return path.join(dir, storageKey);
    };
    return {
        async put(bytes) {
            const plaintext = Buffer.from(bytes);
            const storageKey = `${randomUUID()}.bin`;
            const iv = randomBytes(12);
            const cipher = createCipheriv("aes-256-gcm", key, iv);
            cipher.setAAD(Buffer.from(storageKey));
            const ciphertext = Buffer.concat([
                cipher.update(plaintext),
                cipher.final(),
            ]);
            const blob = Buffer.concat([
                MAGIC,
                iv,
                cipher.getAuthTag(),
                ciphertext,
            ]);
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
            if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC))
                throw new DocumentStoreError("document_corrupt");
            const decipher = createDecipheriv(
                "aes-256-gcm",
                key,
                blob.subarray(4, 16)
            );
            decipher.setAAD(Buffer.from(storageKey));
            decipher.setAuthTag(blob.subarray(16, 32));
            let plaintext;
            try {
                plaintext = Buffer.concat([
                    decipher.update(blob.subarray(32)),
                    decipher.final(),
                ]);
            } catch {
                throw new DocumentStoreError("document_corrupt");
            }
            if (expectedSha256 && sha256(plaintext) !== expectedSha256)
                throw new DocumentStoreError("document_hash_mismatch");
            return plaintext;
        },
    };
}
