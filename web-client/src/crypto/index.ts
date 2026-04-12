// fast_chat/web-client/src/crypto/index.ts
// @ts-ignore
import nacl from "tweetnacl";
// @ts-ignore
import naclUtil from "tweetnacl-util";

export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

export class CryptoService {
    static generateKeypair(): KeyPair {
        const pair = nacl.box.keyPair();
        return { publicKey: pair.publicKey, secretKey: pair.secretKey };
    }

    static async encryptMessage(
        content: string,
        recipientPublicKey: Uint8Array,
        senderSecretKey: Uint8Array,
    ): Promise<string> {
        const message = naclUtil.decodeUTF8(content);
        const nonce = nacl.randomBytes(nacl.box.nonceLength);
        const encrypted = nacl.box(
            message,
            nonce,
            recipientPublicKey,
            senderSecretKey,
        );
        const combined = new Uint8Array(nonce.length + encrypted.length);
        combined.set(nonce);
        combined.set(encrypted, nonce.length);
        return naclUtil.encodeBase64(combined);
    }

    static async decryptMessage(
        encryptedContent: string,
        senderPublicKey: Uint8Array,
        recipientSecretKey: Uint8Array,
    ): Promise<string> {
        const combined = naclUtil.decodeBase64(encryptedContent);
        if (combined.length < nacl.box.nonceLength + nacl.box.overheadLength) {
            throw new Error("Invalid encrypted content");
        }
        const nonce = combined.slice(0, nacl.box.nonceLength);
        const ciphertext = combined.slice(nacl.box.nonceLength);
        const decrypted = nacl.box.open(
            ciphertext,
            nonce,
            senderPublicKey,
            recipientSecretKey,
        );
        if (!decrypted) throw new Error("Decryption failed");
        return naclUtil.encodeUTF8(decrypted);
    }
}

// Key management in IndexedDB
export async function getOrCreateKeypair(): Promise<KeyPair> {
    const db = await import("@/db").then((m) => m.getDb());
    const keypair = (await db.get("keys", "current")) as KeyPair | null;
    if (keypair) return keypair;
    const newPair = CryptoService.generateKeypair();
    await db.put("keys", newPair, "current");
    // Also upload public key to server
    const api = await import("@/api/client").then((m) => m.api);
    const tokens = await api.getTokens();
    if (tokens.access) {
        await fetch("/api/auth/update-public-key", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${tokens.access}`,
            },
            body: JSON.stringify({
                public_key: naclUtil.encodeBase64(newPair.publicKey),
            }),
        });
    }
    return newPair;
}
