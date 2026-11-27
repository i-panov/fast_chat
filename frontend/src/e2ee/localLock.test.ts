import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { E2EBackupError } from "./backup.ts";
import { generateIdentityKeyPair, generateKeyPair } from "./crypto.ts";
import {
	confirmNewKey,
	ensureAccountKeys,
	getAccountScope,
	getKeyHistory,
	getMyKeyPair,
	isLocalLockUnlocked,
	LocalLockRequiredError,
	lockLocalKeys,
	setUnlockedMasterKeys,
} from "./keys.ts";
import {
	enableLocalPin,
	isWeakLocalPin,
	LOCAL_PIN_PATTERN,
	LocalLockThrottledError,
	unlockLocalPin,
	WeakLocalPinError,
} from "./localLock.ts";

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(() => ({
		publicKey: "",
		identityPublicKey: "",
		masterKeyVersion: 1,
	})),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
	getSessions: vi.fn(() =>
		Promise.resolve({ currentSessionId: "s1", sessions: [] }),
	),
}));

let scopeCounter = 0;

function createKeys() {
	setActiveAccountKey(`local-lock-${scopeCounter++}:test`);
	confirmNewKey();
	return ensureAccountKeys("token");
}

describe("local PIN strength", () => {
	it("keeps the shared 6-digit contract", () => {
		expect(LOCAL_PIN_PATTERN.test("482913")).toBe(true);
		expect(LOCAL_PIN_PATTERN.test("48291")).toBe(false);
	});

	it("rejects obvious PINs before wrapping the key", async () => {
		const keys = await createKeys();
		for (const weak of ["000000", "111111", "123456", "654321"]) {
			expect(isWeakLocalPin(weak)).toBe(true);
		}
		await expect(enableLocalPin("123456")).rejects.toBeInstanceOf(
			WeakLocalPinError,
		);
		expect(await metaRepo.get("e2ee.localLock")).toBeUndefined();
		expect(isLocalLockUnlocked()).toBe(true);
		expect((await getMyKeyPair())?.publicKey).toBe(keys.publicKey);
	});

	it("accepts a non-trivial PIN", async () => {
		await createKeys();
		await enableLocalPin("482913");
		expect(await metaRepo.get("e2ee.localLock")).not.toBeNull();
	});
});

describe("local PIN unlocking", () => {
	beforeEach(async () => {
		await createKeys();
		await enableLocalPin("482913");
		lockLocalKeys();
	});

	it("rejects a wrong PIN without unlocking", async () => {
		await expect(unlockLocalPin("111222")).rejects.toBeInstanceOf(
			E2EBackupError,
		);
		expect(isLocalLockUnlocked()).toBe(false);
	});

	it("throttles repeated wrong attempts, including the correct PIN", async () => {
		for (let i = 0; i < 3; i += 1) {
			await expect(unlockLocalPin("111222")).rejects.toBeInstanceOf(
				E2EBackupError,
			);
		}
		await expect(unlockLocalPin("482913")).rejects.toBeInstanceOf(
			LocalLockThrottledError,
		);
		expect(isLocalLockUnlocked()).toBe(false);
	});

	it("unlocks with the right PIN and clears the failure counter", async () => {
		await expect(unlockLocalPin("111222")).rejects.toBeInstanceOf(
			E2EBackupError,
		);
		await unlockLocalPin("482913");
		expect(isLocalLockUnlocked()).toBe(true);
		expect(await metaRepo.get("e2ee.localLockFailures")).toBeNull();
		expect(await getKeyHistory()).toEqual([]);
	});
});

describe("stale unlock races", () => {
	it("refuses to install keys from an unlock that outlived the lock epoch", async () => {
		const scope = getAccountScope();
		const keyPair = await generateKeyPair();
		const identityKeyPair = await generateIdentityKeyPair();
		// Simulate a remote "lock now" that happened while the slow KDF ran.
		lockLocalKeys(scope);
		await expect(
			setUnlockedMasterKeys(
				{ keyPair, identityKeyPair, keyVersion: 1 },
				scope,
				0,
			),
		).rejects.toBeInstanceOf(LocalLockRequiredError);
	});
});
