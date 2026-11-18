import { randomUUID } from "node:crypto";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    PutObjectCommand,
    S3Client,
} from "@aws-sdk/client-s3";
import { open, seal, sha256, DocumentStoreError } from "./crypto.js";

const STORAGE_KEY = /^docs\/[0-9a-f-]{36}\.bin$/;

export function createR2DocumentStore({ client, bucket, key }) {
    if (!Buffer.isBuffer(key) || key.length !== 32)
        throw new DocumentStoreError("invalid_key");
    const input = (storageKey) => {
        if (!STORAGE_KEY.test(storageKey))
            throw new DocumentStoreError("invalid_storage_key");
        return { Bucket: bucket, Key: storageKey };
    };
    return {
        async put(bytes) {
            const storageKey = "docs/" + randomUUID() + ".bin";
            await client.send(
                new PutObjectCommand({
                    ...input(storageKey),
                    Body: seal(key, storageKey, bytes),
                    ContentType: "application/octet-stream",
                })
            );
            return {
                storage_key: storageKey,
                sha256: sha256(bytes),
                size: bytes.length,
            };
        },
        async get(storageKey, { expectedSha256 } = {}) {
            const result = await client.send(
                new GetObjectCommand(input(storageKey))
            );
            const bytes = open(
                key,
                storageKey,
                Buffer.from(await result.Body.transformToByteArray())
            );
            if (expectedSha256 && sha256(bytes) !== expectedSha256)
                throw new DocumentStoreError("integrity_failed");
            return bytes;
        },
        async delete(storageKey) {
            await client.send(new DeleteObjectCommand(input(storageKey)));
        },
    };
}

export function fileStoreFromConfig({ r2, encryptionKey }) {
    const { accountId, bucket, accessKeyId, secretAccessKey } = r2;
    return createR2DocumentStore({
        client: new S3Client({
            endpoint: "https://" + accountId + ".r2.cloudflarestorage.com",
            region: "auto",
            credentials: { accessKeyId, secretAccessKey },
            requestChecksumCalculation: "WHEN_REQUIRED",
            responseChecksumValidation: "WHEN_REQUIRED",
        }),
        bucket,
        key: encryptionKey,
    });
}
