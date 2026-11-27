import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { encodeServerBackup, encryptBackupData } from "./backup.ts";
import {
	generateIdentityKeyPair,
	generateKeyPair,
	type KeyPair,
} from "./crypto.ts";
import {
	clearLocalKeys,
	confirmNewKey,
	createNewKey,
	discardRecoveryAndGenerate,
	ensureAccountKeys,
	getMyKeyPair,
	getMyKeyVersion,
	getServerBackupState,
	hasLocalLock,
	isLocalLockUnlocked,
	KeyBackupCheckFailedError,
	lockLocalKeys,
	NewKeyConfirmationRequiredError,
	RecoveryRequiredError,
	restoreKeyPairFromBackup,
	uploadKeyBackup,
} from "./keys.ts";
import { enableLocalPin, unlockLocalPin } from "./localLock.ts";

// The api module is mocked so we can simulate the server's key-backup
// behaviour without a network.
let backupOnServer: string | null;
let failGetKeyBackupWith: Error | null = null;
let uploadCount = 0;
let lastUploadedVersion = 0;
let serverPublicKey = "";
let serverVersion = 1;
let otherDevice = false;

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(
		(_token: string, _key: string, _identity: string, version: number) => {
			uploadCount += 1;
			lastUploadedVersion = version;
		},
	),
	getPublicKey: vi.fn(() => ({
		publicKey: serverPublicKey,
		identityPublicKey: "",
		keyVersion: "v",
		masterKeyVersion: serverVersion,
	})),
	getKeyBackup: vi.fn(() => {
		if (failGetKeyBackupWith !== null) throw failGetKeyBackupWith;
		if (backupOnServer === null) {
			throw new Error("http 404: no key backup");
		}
		return { backup: backupOnServer };
	}),
	getSessions: vi.fn(() =>
		Promise.resolve({
			currentSessionId: "s1",
			sessions: otherDevice
				? [
						{ id: "s1", current: true },
						{ id: "s2", current: false },
					]
				: [{ id: "s1", current: true }],
		}),
	),
	setKeyBackup: vi.fn((_token: string, backup: string) => {
		backupOnServer = backup;
	}),
	deleteKeyBackup: vi.fn(() => {
		backupOnServer = null;
	}),
}));

// ensureAccountKeys keeps an in-memory per-account cache, so each test uses
// a distinct account scope to avoid leaking state between tests.
let scopeCounter = 0;
function freshScope() {
	setActiveAccountKey(`acc-${scopeCounter++}:test.local`);
}

// uploadKeyBackup follows the stored master key, never a possibly stale
// value from the UI. Seed the storage as a logged-in device would have it.
async function seedKey(kp: KeyPair) {
	await metaRepo.setNoNotify("e2ee.publicKey", kp.publicKey);
	await metaRepo.setNoNotify("e2ee.privateKey", kp.privateKey);
	await metaRepo.setNoNotify("e2ee.keyVersion", 1);
}

describe("key server backup integration", () => {
	beforeEach(() => {
		freshScope();
		backupOnServer = null;
		failGetKeyBackupWith = null;
		uploadCount = 0;
		lastUploadedVersion = 0;
		serverPublicKey = "";
		serverVersion = 1;
		otherDevice = false;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("asks before creating the first key", async () => {
		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			NewKeyConfirmationRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();

		confirmNewKey();
		const kp = await ensureAccountKeys("token");
		expect(kp.privateKey).toBeTruthy();
	});

	it("creates a key after confirmation even if a rejected flight is still around", async () => {
		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			NewKeyConfirmationRequiredError,
		);
		const kp = await createNewKey("token");
		expect(kp.privateKey).toBeTruthy();
		expect(await getMyKeyPair()).not.toBeNull();
		expect(uploadCount).toBe(1);
	});

	it("generates a fresh pair when the server has no backup", async () => {
		confirmNewKey();
		const kp = await ensureAccountKeys("token");
		expect(kp.publicKey).toBeTruthy();
		expect(kp.privateKey).toBeTruthy();
		expect(await getMyKeyPair()).not.toBeNull();
	});

	it("asks before a per-device key when other devices exist", async () => {
		otherDevice = true;

		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			NewKeyConfirmationRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();
		expect(uploadCount).toBe(0);

		confirmNewKey();
		expect(await ensureAccountKeys("token")).toBeTruthy();
	});

	it("is single-flight: concurrent calls share one key pair", async () => {
		confirmNewKey();
		// Two racing callers with no backup must converge on a single pair
		// and generate/upload exactly once (no divergent duplicates).
		const [a, b] = await Promise.all([
			ensureAccountKeys("token"),
			ensureAccountKeys("token"),
		]);
		expect(a.privateKey).toBe(b.privateKey);
		expect(a.publicKey).toBe(b.publicKey);
		expect(uploadCount).toBe(1);
	});

	it("is single-flight on the recovery path: emits the event once", async () => {
		const kp = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		backupOnServer = encodeServerBackup({
			v: 4,
			password: await encryptBackupData("pw", {
				keyPair: kp,
				identityKeyPair: identity,
				keyVersion: 1,
			}),
		});

		let events = 0;
		const handler = () => {
			events += 1;
		};
		window.addEventListener("e2ee:recovery-needed", handler);

		await Promise.allSettled([
			ensureAccountKeys("token"),
			ensureAccountKeys("token"),
		]);

		window.removeEventListener("e2ee:recovery-needed", handler);
		expect(events).toBe(1);
		expect(await getMyKeyPair()).toBeNull();
	});

	it("does not generate and signals recovery when a backup exists", async () => {
		const kp = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		backupOnServer = encodeServerBackup({
			v: 4,
			password: await encryptBackupData("pw", {
				keyPair: kp,
				identityKeyPair: identity,
				keyVersion: 1,
			}),
		});

		let recoverySignalled = false;
		const handler = () => {
			recoverySignalled = true;
		};
		window.addEventListener("e2ee:recovery-needed", handler);

		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			RecoveryRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();

		window.removeEventListener("e2ee:recovery-needed", handler);
		expect(recoverySignalled).toBe(true);
	});

	it("offers recovery for a newer backup on a fresh device", async () => {
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 2,
			password: "b2xk",
		});
		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			RecoveryRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();
	});

	it("reports a backup older than the local key as stale", async () => {
		await metaRepo.setNoNotify("e2ee.keyVersion", 2);
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 1,
			password: "b2xk",
		});
		expect(await getServerBackupState("token")).toBe("stale");
	});

	it("does not clobber an existing backup when the fetch is ambiguous", async () => {
		// An unexpected failure (e.g. network) must not lead to generating
		// a divergent key pair that would orphan the existing backup.
		backupOnServer = "opaque-blob";
		failGetKeyBackupWith = new Error("network down");

		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			KeyBackupCheckFailedError,
		);
		expect(await getMyKeyPair()).toBeNull();
	});

	it("recovers the key pair from a backup stored earlier", async () => {
		const kp = await generateKeyPair();
		await seedKey(kp);
		await uploadKeyBackup("token", "correct-password");
		expect(backupOnServer).not.toBeNull();

		const recovered = await restoreKeyPairFromBackup(
			"token",
			"correct-password",
		);
		expect(recovered.publicKey).toBe(kp.publicKey);
		expect(recovered.privateKey).toBe(kp.privateKey);
		expect(await getMyKeyPair()).toEqual(recovered);
	});

	it("restores a backup that matches the published server key", async () => {
		const kp = await generateKeyPair();
		await seedKey(kp);
		await uploadKeyBackup("token", "right");
		serverPublicKey = kp.publicKey;
		serverVersion = 1;
		await clearLocalKeys();

		const recovered = await restoreKeyPairFromBackup("token", "right");
		expect(recovered).toEqual(kp);
		expect(await metaRepo.get("e2ee.publicKeyUploaded")).toBe(true);
	});

	it("rejects recovery with a wrong password and leaves no local keys", async () => {
		const kp = await generateKeyPair();
		await seedKey(kp);
		await uploadKeyBackup("token", "right");
		await clearLocalKeys();

		await expect(restoreKeyPairFromBackup("token", "wrong")).rejects.toThrow();
		expect(await getMyKeyPair()).toBeNull();
	});

	it("discarding recovery clears the stale backup and generates new keys", async () => {
		const stale = await generateKeyPair();
		await seedKey(stale);
		await uploadKeyBackup("token", "old-password");
		await clearLocalKeys();
		expect(backupOnServer).not.toBeNull();

		const fresh = await discardRecoveryAndGenerate("token");
		const local = await getMyKeyPair();
		expect(backupOnServer).toBeNull();
		expect(fresh.privateKey).not.toBe(stale.privateKey);
		expect(local?.privateKey).toBe(fresh.privateKey);
	});

	it("publishes the discarded replacement above the server version", async () => {
		// The server still holds the old public key at version 4. A
		// version-1 replacement would be rejected as a rollback forever.
		serverPublicKey = "old-key";
		serverVersion = 4;
		await clearLocalKeys();

		const fresh = await discardRecoveryAndGenerate("token");
		expect(fresh.privateKey).toBeTruthy();
		expect(lastUploadedVersion).toBe(5);
	});

	it("replaces an existing local key when recovery is discarded", async () => {
		const old = await generateKeyPair();
		await seedKey(old);
		serverPublicKey = "old-key";
		serverVersion = 1;

		const fresh = await discardRecoveryAndGenerate("token");
		expect(fresh.privateKey).not.toBe(old.privateKey);
		expect(await getMyKeyPair()).toEqual(fresh);
		expect(await getMyKeyVersion()).toBe(2);
		expect(lastUploadedVersion).toBe(2);
	});
	it("wraps the master key under a 6-digit PIN", async () => {
		setActiveAccountKey(`alice-pin-${Date.now()}:test`);
		confirmNewKey();
		const keys = await ensureAccountKeys("token");
		await enableLocalPin("123456");
		expect(await hasLocalLock()).toBe(true);

		lockLocalKeys();
		expect(isLocalLockUnlocked()).toBe(false);
		expect(await getMyKeyPair()).toBeNull();
		await expect(unlockLocalPin("000000")).rejects.toThrow();
		await unlockLocalPin("123456");
		expect(isLocalLockUnlocked()).toBe(true);
		expect((await getMyKeyPair())?.publicKey).toBe(keys.publicKey);
	});
});
