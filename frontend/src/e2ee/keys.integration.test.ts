import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { generateKeyPair } from "./crypto.ts";
import {
	discardRecoveryAndGenerate,
	ensureAccountKeys,
	getMyKeyPair,
	RecoveryRequiredError,
	restoreKeyPairFromBackup,
	uploadKeyBackup,
} from "./keys.ts";

// The api module is mocked so we can simulate the server's key-backup
// behaviour without a network.
let backupOnServer: string | null;
let failGetKeyBackupWith: Error | null = null;
let uploadCount = 0;

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(async () => {
		uploadCount += 1;
	}),
	getPublicKey: vi.fn(async () => ({ publicKey: "x", keyVersion: "v" })),
	getKeyBackup: vi.fn(async () => {
		if (failGetKeyBackupWith !== null) throw failGetKeyBackupWith;
		if (backupOnServer === null) {
			throw new Error("http 404: no key backup");
		}
		return { backup: backupOnServer as string };
	}),
	setKeyBackup: vi.fn(async (_token: string, backup: string) => {
		backupOnServer = backup;
	}),
	deleteKeyBackup: vi.fn(async () => {
		backupOnServer = null;
	}),
}));

// ensureAccountKeys keeps an in-memory per-account cache, so each test uses
// a distinct account scope to avoid leaking state between tests.
let scopeCounter = 0;
function freshScope() {
	setActiveAccountKey(`acc-${scopeCounter++}:test.local`);
}

describe("key server backup integration", () => {
	beforeEach(() => {
		freshScope();
		backupOnServer = null;
		failGetKeyBackupWith = null;
		uploadCount = 0;
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("generates a fresh pair when the server has no backup", async () => {
		const kp = await ensureAccountKeys("token");
		expect(kp.publicKey).toBeTruthy();
		expect(kp.privateKey).toBeTruthy();
		expect(await getMyKeyPair()).not.toBeNull();
	});

	it("is single-flight: concurrent calls share one key pair", async () => {
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
		backupOnServer = "opaque-blob";

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
		backupOnServer = "opaque-blob";

		let recoverySignalled = false;
		const handler = () => {
			recoverySignalled = true;
		};
		window.addEventListener("e2ee:recovery-needed", handler);

		await expect(ensureAccountKeys("token")).rejects.toThrow(
			RecoveryRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();

		window.removeEventListener("e2ee:recovery-needed", handler);
		expect(recoverySignalled).toBe(true);
	});

	it("does not clobber an existing backup when the fetch is ambiguous", async () => {
		// An unexpected failure (e.g. network) must not lead to generating
		// a divergent key pair that would orphan the existing backup.
		backupOnServer = "opaque-blob";
		failGetKeyBackupWith = new Error("network down");

		await expect(ensureAccountKeys("token")).rejects.toThrow(
			RecoveryRequiredError,
		);
		expect(await getMyKeyPair()).toBeNull();
	});

	it("recovers the key pair from a backup stored earlier", async () => {
		const kp = await generateKeyPair();
		await uploadKeyBackup("token", "correct-password", kp);
		expect(backupOnServer).not.toBeNull();

		const recovered = await restoreKeyPairFromBackup(
			"token",
			"correct-password",
		);
		expect(recovered.publicKey).toBe(kp.publicKey);
		expect(recovered.privateKey).toBe(kp.privateKey);
		expect(await getMyKeyPair()).toEqual(recovered);
	});

	it("rejects recovery with a wrong password and leaves no local keys", async () => {
		const kp = await generateKeyPair();
		await uploadKeyBackup("token", "right", kp);

		await expect(restoreKeyPairFromBackup("token", "wrong")).rejects.toThrow();
		expect(await getMyKeyPair()).toBeNull();
	});

	it("discarding recovery clears the stale backup and generates new keys", async () => {
		const stale = await generateKeyPair();
		await uploadKeyBackup("token", "old-password", stale);
		expect(backupOnServer).not.toBeNull();

		const fresh = await discardRecoveryAndGenerate("token");
		const local = await getMyKeyPair();
		expect(backupOnServer).toBeNull();
		expect(fresh.privateKey).not.toBe(stale.privateKey);
		expect(local?.privateKey).toBe(fresh.privateKey);
	});
});
