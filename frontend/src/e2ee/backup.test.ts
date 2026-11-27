import { describe, expect, it } from "vitest";
import {
	type BackupData,
	decryptBackupData,
	E2EBackupError,
	encryptBackupData,
} from "./backup.ts";
import { generateIdentityKeyPair, generateKeyPair } from "./crypto.ts";

async function backupData(): Promise<BackupData> {
	return {
		keyPair: await generateKeyPair(),
		identityKeyPair: await generateIdentityKeyPair(),
		keyVersion: 1,
	};
}

describe("key backup roundtrip", () => {
	it("recovers the master key, identity and version", async () => {
		const data = await backupData();
		const blob = await encryptBackupData("pw", data);

		const recovered = await decryptBackupData("pw", blob);
		expect(recovered.keyPair).toEqual(data.keyPair);
		expect(recovered.identityKeyPair).toEqual(data.identityKeyPair);
		expect(recovered.keyVersion).toBe(1);
	});

	it("rejects a wrong password", async () => {
		const blob = await encryptBackupData("right password", await backupData());

		await expect(decryptBackupData("wrong password", blob)).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("rejects a malformed blob", async () => {
		await expect(
			decryptBackupData("password", "not-a-valid-blob"),
		).rejects.toThrow(E2EBackupError);
		await expect(decryptBackupData("password", "{}")).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("rejects a blob with an unsupported format version", async () => {
		const payload = {
			v: 99,
			salt: btoa("salt"),
			nonce: btoa("nonce-nonce-nonce"),
			ct: btoa("ciphertext"),
		};
		const blob = btoa(JSON.stringify(payload));
		await expect(decryptBackupData("password", blob)).rejects.toThrow(
			E2EBackupError,
		);
	});

	it("produces different blobs for the same keys", async () => {
		const data = await backupData();
		const a = await encryptBackupData("pw", data);
		const b = await encryptBackupData("pw", data);
		expect(a).not.toBe(b);
	});

	it("does not leak the key material in the blob", async () => {
		const data = await backupData();
		const blob = await encryptBackupData("pw", data);
		expect(blob).not.toContain(data.keyPair.privateKey);
		expect(blob).not.toContain(data.identityKeyPair.privateKey);
		expect(blob).not.toContain(data.keyPair.publicKey.slice(0, 20));
	});
});
