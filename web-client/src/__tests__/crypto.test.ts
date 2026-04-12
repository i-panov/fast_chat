import { describe, it, expect } from "vitest";
import { CryptoService } from "@/crypto";

describe("CryptoService", () => {
    it("should encrypt and decrypt message", async () => {
        const alice = CryptoService.generateKeypair();
        const bob = CryptoService.generateKeypair();
        const message = "Hello Bob!";
        const encrypted = await CryptoService.encryptMessage(
            message,
            bob.publicKey,
            alice.secretKey,
        );
        const decrypted = await CryptoService.decryptMessage(
            encrypted,
            alice.publicKey,
            bob.secretKey,
        );
        expect(decrypted).toBe(message);
    });

    it("should generate keypair", () => {
        const pair = CryptoService.generateKeypair();
        expect(pair.publicKey).toBeInstanceOf(Uint8Array);
        expect(pair.secretKey).toBeInstanceOf(Uint8Array);
        expect(pair.publicKey.length).toBe(32);
        expect(pair.secretKey.length).toBe(32);
    });
});
