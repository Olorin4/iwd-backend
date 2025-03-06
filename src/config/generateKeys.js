import fs from "fs";
import path from "path";
import { generateKeyPairSync } from "crypto";

const keysDir = path.resolve("./src/config/keys");

// Ensure the "keys" directory exists, if not, create it
if (!fs.existsSync(keysDir)) fs.mkdirSync(keysDir);

// Paths for private and public key files
const privateKeyPath = path.join(keysDir, "priv_key.pem");
const publicKeyPath = path.join(keysDir, "pub_key.pem");

// Generate keys only if they don’t exist
if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
    console.log("Generating RSA key pair...");

    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048, // RSA key size (2048 bits for security)
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });

    // Write keys to files
    fs.writeFileSync(privateKeyPath, privateKey);
    fs.writeFileSync(publicKeyPath, publicKey);
    console.log("RSA key pair generated and saved in ./keys directory.");
}

// Read keys for use in authentication
export const privateKey = fs.readFileSync(privateKeyPath, "utf8");
export const publicKey = fs.readFileSync(publicKeyPath, "utf8");
