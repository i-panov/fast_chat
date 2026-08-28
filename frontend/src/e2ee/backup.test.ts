import { describe, expect, it } from "vitest";
import { decryptBackup, E2EBackupError, encryptBackup } from "./backup.ts";
import { generateKeyPair } from "./crypto.ts";

describe("key backup roundtrip", () => {
	it("recovers the key pair with the correct password", async () => {
		const kp = await generateKeyPair();
		const blob = await encryptBackup("correct horse battery staple", kp);

		const recovered = await decryptBackup("correct horse battery staple", blob);
		expect(recovered.publicKey).toBe(kp.publicKey);
		expect(recovered.privateKey).toBe(kp.privateKey);
	});

	it("rejects a wrong password", async () => {
		const kp = await generateKeyPair();
		const blob = await encryptBackup("right password", kp);

		await expect(decryptBackup("wrong password", blob)).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("rejects a malformed blob", async () => {
		await expect(decryptBackup("password", "not-a-valid-blob")).rejects.toThrow(
			E2EBackupError,
		);
		await expect(decryptBackup("password", "{}")).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("rejects a blob with an unsupported format version", async () => {
		// Well-shaped payload (valid base64 fields) but an unknown version:
		// must be rejected before any decryption/parse of the ciphertext.
		const payload = {
			v: 99,
			salt: btoa("salt"),
			nonce: btoa("nonce-nonce-nonce"),
			ct: btoa("ciphertext"),
		};
		const blob = btoa(JSON.stringify(payload));
		await expect(decryptBackup("password", blob)).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("produces different blobs for the same key pair", async () => {
		const kp = await generateKeyPair();
		const a = await encryptBackup("pw", kp);
		const b = await encryptBackup("pw", kp);
		expect(a).not.toBe(b);
	});

	it("does not leak the key material in the blob", async () => {
		const kp = await generateKeyPair();
		const blob = await encryptBackup("pw", kp);
		expect(blob).not.toContain(kp.privateKey);
		expect(blob).not.toContain(kp.publicKey.slice(0, 20));
	});
});
