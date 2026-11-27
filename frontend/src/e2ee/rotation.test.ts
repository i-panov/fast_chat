import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import {
	decodeServerBackup,
	encodeServerBackup,
	encryptBackupData,
} from "./backup.ts";
import { generateIdentityKeyPair, generateKeyPair } from "./crypto.ts";
import {
	confirmNewKey,
	discardRecoveryAndGenerate,
	ensureAccountKeys,
	getIdentityChain,
	getIdentityKeyPair,
	getKeyHistory,
	getKeyPairForVersion,
	getMyKeyPair,
	getMyKeyVersion,
	isLocalLockUnlocked,
	KeyBackupSaveError,
	LocalLockEnabledError,
	lockLocalKeys,
	PasskeyBackupEnabledError,
	restoreKeyPairFromBackup,
	rotateEncryptionKey,
	rotateSigningKey,
	StaleKeyStateError,
	uploadKeyBackup,
} from "./keys.ts";
import { enableLocalPin, unlockLocalPin } from "./localLock.ts";
import { restoreWithServerPasskey } from "./passkeyLock.ts";

let backupOnServer: string | null = null;
let serverPublicKey = "";
let serverIdentityPublicKey = "";
let serverVersion = 1;
let failNextBackup = false;

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(
		(_token: string, publicKey: string, identity: string, version: number) => {
			serverPublicKey = publicKey;
			serverIdentityPublicKey = identity;
			serverVersion = version;
		},
	),
	getPublicKey: vi.fn(() => ({
		publicKey: serverPublicKey,
		identityPublicKey: serverIdentityPublicKey,
		masterKeyVersion: serverVersion,
	})),
	getKeyBackup: vi.fn(() => {
		if (backupOnServer === null) {
			throw new Error("http 404: no key backup");
		}
		return { backup: backupOnServer };
	}),
	setKeyBackup: vi.fn((_token: string, backup: string, version: number) => {
		if (failNextBackup) {
			failNextBackup = false;
			throw new Error("network down");
		}
		if (version !== serverVersion) throw new Error("http 409: stale backup");
		backupOnServer = backup;
	}),
	deleteKeyBackup: vi.fn(() => {
		backupOnServer = null;
	}),
}));

let scopeCounter = 0;
function freshScope() {
	setActiveAccountKey(`rotation-${scopeCounter++}:test.local`);
}

function createKey() {
	confirmNewKey();
	return ensureAccountKeys("token");
}

const BASE64_PADDING_RE = /=+$/;

describe("master key rotation", () => {
	beforeEach(() => {
		freshScope();
		backupOnServer = null;
		serverPublicKey = "";
		serverIdentityPublicKey = "";
		serverVersion = 1;
		failNextBackup = false;
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("is refused while a local PIN lock is enabled", async () => {
		await createKey();
		await enableLocalPin("123456");

		await expect(rotateEncryptionKey("token", "pw")).rejects.toBeInstanceOf(
			LocalLockEnabledError,
		);
	});

	it("refuses to rotate when the server publishes a different key", async () => {
		await createKey();
		await uploadKeyBackup("token", "pw");
		serverPublicKey = "some-other-key";

		await expect(rotateEncryptionKey("token", "pw")).rejects.toBeInstanceOf(
			StaleKeyStateError,
		);
	});

	it("refuses to wipe a local lock from recovery decline", async () => {
		await createKey();
		await enableLocalPin("123456");

		await expect(discardRecoveryAndGenerate("token")).rejects.toBeInstanceOf(
			LocalLockEnabledError,
		);
	});

	it("advances the version, keeps the old key in history and the backup", async () => {
		const original = await createKey();
		await uploadKeyBackup("token", "pw");

		const rotated = await rotateEncryptionKey("token", "pw");
		expect(rotated.publicKey).not.toBe(original.publicKey);
		expect(await getMyKeyVersion()).toBe(2);
		expect(await getKeyPairForVersion(1)).toEqual(original);

		const history = await getKeyHistory();
		expect(history).toHaveLength(1);
		expect(history[0]?.version).toBe(1);

		const container = decodeServerBackup(backupOnServer ?? "");
		expect(container?.password).toBeTruthy();
	});

	it("keeps the rotated key when the password is changed with a stale pair", async () => {
		await createKey();
		await uploadKeyBackup("token", "pw");
		const rotated = await rotateEncryptionKey("token", "pw");

		// The settings modal may still hold the pre-rotation pair; the
		// backup must follow the current key instead of rolling back.
		await uploadKeyBackup("token", "newpw");

		const restored = await restoreKeyPairFromBackup("token", "newpw");
		expect(restored).toEqual(rotated);
		expect(await getMyKeyVersion()).toBe(2);
	});

	it("rotates the signing key and advances the master version", async () => {
		await createKey();
		await uploadKeyBackup("token", "pw");
		const before = await getIdentityKeyPair();
		if (before === null) throw new Error("no identity");

		const next = await rotateSigningKey("token", "pw");
		expect(next.publicKey).not.toBe(before.publicKey);
		expect(await getMyKeyVersion()).toBe(2);
		expect(await getIdentityKeyPair()).toEqual(next);
		const container = decodeServerBackup(backupOnServer ?? "");
		expect(container?.masterKeyVersion).toBe(2);
	});

	it("reports a published key whose backup could not be saved", async () => {
		await createKey();
		await uploadKeyBackup("token", "pw");
		failNextBackup = true;

		await expect(rotateEncryptionKey("token", "pw")).rejects.toBeInstanceOf(
			KeyBackupSaveError,
		);
		// The new key is published and kept locally; only the backup is old.
		expect(await getMyKeyVersion()).toBe(2);
	});

	it("keeps the private key history out of plaintext while the lock is closed", async () => {
		await createKey();
		await uploadKeyBackup("token", "pw");
		await rotateEncryptionKey("token", "pw");

		await enableLocalPin("123456");
		expect(await metaRepo.get("e2ee.keyHistory")).toBeNull();
		expect(await metaRepo.get("e2ee.identityChain")).toBeNull();

		lockLocalKeys();
		expect(isLocalLockUnlocked()).toBe(false);

		await unlockLocalPin("123456");
		expect(await getKeyHistory()).toHaveLength(1);
		expect(await metaRepo.get("e2ee.keyHistory")).toBeNull();
	});

	it("refuses rotation that would drop the passkey backup wrapper", async () => {
		const original = await createKey();
		const identity = await generateIdentityKeyPair();
		const wrapperBlob = await encryptBackupData("passkey", {
			keyPair: original,
			identityKeyPair: identity,
			keyVersion: 1,
		});
		backupOnServer = encodeServerBackup({
			v: 4,
			password: await encryptBackupData("pw", {
				keyPair: original,
				identityKeyPair: identity,
				keyVersion: 1,
			}),
			passkey: { credentialId: "id", salt: "salt", blob: wrapperBlob },
		});

		await expect(rotateEncryptionKey("token", "pw")).rejects.toBeInstanceOf(
			PasskeyBackupEnabledError,
		);
	});

	it("restores keys and history from a passkey server wrapper", async () => {
		const keyPair = await generateKeyPair();
		const identityKeyPair = await generateIdentityKeyPair();
		const previous = await generateKeyPair();
		const nextIdentity = await generateIdentityKeyPair();
		const prf = new Uint8Array(32).fill(7);
		const prfPassword = btoa(String.fromCharCode(...prf))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(BASE64_PADDING_RE, "");
		const passkeyBlob = await encryptBackupData(prfPassword, {
			keyPair,
			identityKeyPair,
			keyVersion: 3,
			keyHistory: [{ version: 2, keyPair: previous }],
			identityHistory: [identityKeyPair.publicKey],
			identityChain: [
				{
					from: identityKeyPair.publicKey,
					to: nextIdentity.publicKey,
					signature: "sig",
				},
			],
		});
		backupOnServer = encodeServerBackup({
			v: 4,
			password: await encryptBackupData("pw", {
				keyPair,
				identityKeyPair,
				keyVersion: 3,
			}),
			passkey: {
				credentialId: btoa("credential-id"),
				salt: btoa("salt-value"),
				blob: passkeyBlob,
			},
		});

		vi.stubGlobal("navigator", {
			credentials: {
				get: vi.fn(() => ({
					getClientExtensionResults: () => ({
						prf: { results: { first: prf.buffer } },
					}),
				})),
			},
		});

		await restoreWithServerPasskey("token");

		expect(await getMyKeyPair()).toEqual(keyPair);
		expect(await getMyKeyVersion()).toBe(3);
		expect(await getKeyHistory()).toHaveLength(1);
		expect(await getIdentityChain()).toHaveLength(1);
	});
});
