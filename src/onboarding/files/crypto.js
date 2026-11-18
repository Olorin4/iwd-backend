import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from "node:crypto";

const MAGIC = Buffer.from("IWD1");

export class DocumentStoreError extends Error {
    constructor(code) {
        super(code);
        this.name = "DocumentStoreError";
        this.code = code;
    }
}

export const sha256 = (bytes) =>
    createHash("sha256").update(bytes).digest("hex");

export function seal(key, storageKey, plaintext) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from(storageKey));
    const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
    ]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function open(key, storageKey, blob) {
    if (blob.length < 32 || !blob.subarray(0, MAGIC.length).equals(MAGIC))
        throw new DocumentStoreError("integrity_failed");
    try {
        const decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            blob.subarray(4, 16)
        );
        decipher.setAAD(Buffer.from(storageKey));
        decipher.setAuthTag(blob.subarray(16, 32));
        return Buffer.concat([
            decipher.update(blob.subarray(32)),
            decipher.final(),
        ]);
    } catch {
        throw new DocumentStoreError("integrity_failed");
    }
}
