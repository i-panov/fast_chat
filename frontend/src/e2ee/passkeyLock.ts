import { getKeyBackup, setKeyBackup } from "../api.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { clearDecryptedFileCache } from "../utils/fileCache.ts";
import {
	decodeServerBackup,
	decryptBackupData,
	E2EBackupError,
	encodeServerBackup,
	encryptBackupData,
} from "./backup.ts";
import { samePublicKey } from "./crypto.ts";

import {
	assertLocalKeyMatchesServer,
	getAccountScope,
	getIdentityChain,
	getIdentityHistory,
	getIdentityKeyPair,
	getKeyHistory,
	getMyKeyPair,
	getMyKeyVersion,
	hasPinLock,
	IDENTITY_CHAIN_META,
	IDENTITY_HISTORY_META,
	IDENTITY_PRIVATE_KEY_META,
	IDENTITY_PUBLIC_KEY_META,
	isLocalLockUnlocked,
	KEY_HISTORY_META,
	LocalLockRequiredError,
	notifyKeyMaterialChanged,
	PASSKEY_LOCK_META,
	PRIVATE_KEY_META,
	PUBLIC_KEY_META,
	persistUnlockedHistory,
	restoreServerBackupData,
	setUnlockedMasterKeys,
	withAccountKeyLock,
} from "./keys.ts";

const PUBLIC_KEY_CREDENTIAL = "public-key";
const BASE64_PADDING_RE = /=+$/;
const ACCOUNT_CHANGED = "account changed";

// PRF failures are typed so the UI can say what the provider actually did
// instead of falling back to "could not change the local protection".
export class PasskeyPrfUnsupportedError extends Error {
	constructor() {
		super("passkey provider does not support PRF");
	}
}

export class PasskeyPrfMissingError extends Error {
	constructor() {
		super("passkey did not return a PRF output");
	}
}

export class PasskeyPrfUnstableError extends Error {
	constructor() {
		super("passkey returned an unstable PRF output");
	}
}

interface PasskeyRecord {
	v: 1;
	credentialId: string;
	salt: string;
	blob: string;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(BASE64_PADDING_RE, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}

export function isPasskeyUnlockAvailable(): boolean {
	return (
		typeof window !== "undefined" &&
		window.isSecureContext &&
		typeof PublicKeyCredential !== "undefined" &&
		typeof navigator.credentials?.get === "function"
	);
}

interface PrfResults {
	prf?: {
		enabled?: boolean;
		results?: { first?: ArrayBuffer };
	};
}

function prfResult(credential: PublicKeyCredential): ArrayBuffer {
	const results = credential.getClientExtensionResults() as PrfResults;
	const first = results.prf?.results?.first;
	if (first === undefined) throw new PasskeyPrfMissingError();
	return first;
}

async function assertPasskey(
	credentialId: Uint8Array<ArrayBuffer>,
	salt: Uint8Array<ArrayBuffer>,
): Promise<ArrayBuffer> {
	const credential = await navigator.credentials.get({
		publicKey: {
			challenge: randomBytes(32),
			allowCredentials: [{ id: credentialId, type: PUBLIC_KEY_CREDENTIAL }],
			userVerification: "required",
			extensions: { prf: { eval: { first: salt } } },
		},
	});
	if (credential === null) throw new Error("passkey assertion cancelled");
	return prfResult(credential as PublicKeyCredential);
}

// createPasskey registers the credential and reads the PRF capability in the
// same call. Evaluating PRF at creation saves a prompt when the authenticator
// returns the output right away; a provider that reports prf.enabled: false
// can never unwrap the key, so it fails before the confirmation assertion.
async function createPasskey(salt: Uint8Array<ArrayBuffer>): Promise<{
	credentialId: Uint8Array<ArrayBuffer>;
	prf: ArrayBuffer | null;
}> {
	const created = (await navigator.credentials.create({
		publicKey: {
			challenge: randomBytes(32),
			rp: { name: "Fast Chat", id: window.location.hostname },
			user: {
				id: randomBytes(32),
				name: "fastchat",
				displayName: "Fast Chat",
			},
			pubKeyCredParams: [
				{ type: PUBLIC_KEY_CREDENTIAL, alg: -7 },
				{ type: PUBLIC_KEY_CREDENTIAL, alg: -257 },
			],
			authenticatorSelection: {
				userVerification: "required",
				residentKey: "preferred",
			},
			extensions: { prf: { eval: { first: salt } } },
		},
	})) as PublicKeyCredential | null;
	if (created === null) throw new Error("passkey registration cancelled");

	const results = created.getClientExtensionResults() as PrfResults;
	if (results.prf?.enabled === false) throw new PasskeyPrfUnsupportedError();
	return {
		credentialId: new Uint8Array(created.rawId),
		prf: results.prf?.results?.first ?? null,
	};
}

// enablePasskey stores a second wrapper of the master key under the PRF
// output of a platform passkey. It does not replace the PIN or server backup.
export function enablePasskey(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => enablePasskeyLocked(scope));
}

async function enablePasskeyLocked(scope: string): Promise<void> {
	if (!isPasskeyUnlockAvailable()) {
		throw new Error("passkeys are not available in this browser");
	}
	const salt = randomBytes(32);
	const created = await createPasskey(salt);
	const credentialId = created.credentialId;
	const prf = created.prf ?? (await assertPasskey(credentialId, salt));
	const keyPair = await getMyKeyPair(scope);
	const identityKeyPair = await getIdentityKeyPair(scope);
	if (keyPair === null || identityKeyPair === null) {
		throw new Error("no local keys to protect");
	}
	const passkeyPassword = toBase64Url(new Uint8Array(prf));
	const blob = await encryptBackupData(passkeyPassword, {
		keyPair,
		identityKeyPair,
		keyVersion: await getMyKeyVersion(scope),
		keyHistory: await getKeyHistory(scope),
		identityHistory: await getIdentityHistory(scope),
		identityChain: await getIdentityChain(scope),
	});
	const record: PasskeyRecord = {
		v: 1,
		credentialId: toBase64Url(credentialId),
		salt: toBase64Url(salt),
		blob,
	};
	if (getAccountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await metaRepo.setNoNotifyFor(
		scope,
		PASSKEY_LOCK_META,
		JSON.stringify(record),
	);
	// The PRF output may differ between assertions (unstable authenticator).
	// Prove the wrapper opens with a *second* assertion before deleting the
	// only plaintext keys.
	try {
		const confirmPrf = await assertPasskey(credentialId, salt);
		const storedRaw = await metaRepo.getFor(scope, PASSKEY_LOCK_META);
		if (typeof storedRaw !== "string" || storedRaw === "") {
			throw new Error("passkey lock verification failed");
		}
		const storedRecord = JSON.parse(storedRaw) as PasskeyRecord;
		const check = await decryptBackupData(
			toBase64Url(new Uint8Array(confirmPrf)),
			storedRecord.blob,
		);
		if (
			!samePublicKey(check.keyPair.publicKey, keyPair.publicKey) ||
			!samePublicKey(check.identityKeyPair.publicKey, identityKeyPair.publicKey)
		) {
			throw new PasskeyPrfUnstableError();
		}
	} catch (err) {
		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
		throw err instanceof E2EBackupError ? new PasskeyPrfUnstableError() : err;
	}
	await Promise.all([
		metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, PRIVATE_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_PUBLIC_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_PRIVATE_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, null),
	]);
	await clearDecryptedFileCache(scope === "" ? null : scope);
	notifyKeyMaterialChanged(scope);
}

export async function hasPasskeyLock(
	scope: string = getAccountScope(),
): Promise<boolean> {
	const value = await metaRepo.getFor(scope, PASSKEY_LOCK_META);
	return typeof value === "string" && value !== "";
}

export function unlockWithPasskey(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => unlockWithPasskeyLocked(scope));
}

async function unlockWithPasskeyLocked(scope: string): Promise<void> {
	const raw = await metaRepo.getFor(scope, PASSKEY_LOCK_META);
	if (typeof raw !== "string" || raw === "") {
		throw new Error("passkey lock is not configured");
	}
	const record = JSON.parse(raw) as PasskeyRecord;
	const prf = await assertPasskey(
		fromBase64Url(record.credentialId),
		fromBase64Url(record.salt),
	);
	const data = await decryptBackupData(
		toBase64Url(new Uint8Array(prf)),
		record.blob,
	);
	await setUnlockedMasterKeys(data, scope);
	notifyKeyMaterialChanged(scope);
}

// enableServerPasskey adds a second, passkey-PRF wrapper to the server backup.
// It requires an existing password wrapper as the portable fallback.
export function enableServerPasskey(token: string): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () =>
		enableServerPasskeyLocked(scope, token),
	);
}

async function enableServerPasskeyLocked(
	scope: string,
	token: string,
): Promise<void> {
	if (!isPasskeyUnlockAvailable()) {
		throw new Error("passkeys are not available in this browser");
	}
	const current = await getKeyBackup(token);
	const container = decodeServerBackup(current.backup);
	if (container?.password === undefined) {
		throw new Error("set the backup password first");
	}
	// A device that lost a rotation race must not wrap its orphan key with a
	// passkey: the password wrapper belongs to the server key.
	await assertLocalKeyMatchesServer(token, scope);
	const salt = randomBytes(32);
	const created = await createPasskey(salt);
	const credentialId = created.credentialId;
	const prf = created.prf ?? (await assertPasskey(credentialId, salt));
	const keyPair = await getMyKeyPair(scope);
	const identityKeyPair = await getIdentityKeyPair(scope);
	if (keyPair === null || identityKeyPair === null) {
		throw new Error("no local keys to protect");
	}
	const blob = await encryptBackupData(toBase64Url(new Uint8Array(prf)), {
		keyPair,
		identityKeyPair,
		keyVersion: await getMyKeyVersion(scope),
		keyHistory: await getKeyHistory(scope),
		identityHistory: await getIdentityHistory(scope),
		identityChain: await getIdentityChain(scope),
	});
	const version = await getMyKeyVersion(scope);
	if (getAccountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	// A second assertion proves the PRF output is stable before the server
	// stores a wrapper that may otherwise never open.
	const confirmPrf = await assertPasskey(credentialId, salt);
	const check = await decryptBackupData(
		toBase64Url(new Uint8Array(confirmPrf)),
		blob,
	).catch((err: unknown) => {
		throw err instanceof E2EBackupError ? new PasskeyPrfUnstableError() : err;
	});
	if (
		!samePublicKey(check.keyPair.publicKey, keyPair.publicKey) ||
		!samePublicKey(check.identityKeyPair.publicKey, identityKeyPair.publicKey)
	) {
		throw new PasskeyPrfUnstableError();
	}
	await setKeyBackup(
		token,
		encodeServerBackup({
			...container,
			masterKeyVersion: version,
			passkey: {
				credentialId: toBase64Url(credentialId),
				salt: toBase64Url(salt),
				blob,
			},
		}),
		version,
	);
	notifyKeyMaterialChanged(scope);
}

// disableServerPasskey removes the PRF wrapper while keeping the password
// wrapper. Rotation requires this: otherwise the new key would only be
// recoverable with the password that was just verified.
export function disableServerPasskey(token: string): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () =>
		disableServerPasskeyLocked(scope, token),
	);
}

async function disableServerPasskeyLocked(
	scope: string,
	token: string,
): Promise<void> {
	// Re-read inside the lock: a concurrent password change must not be
	// overwritten with the stale password wrapper.
	const current = await getKeyBackup(token);
	const container = decodeServerBackup(current.backup);
	if (container?.passkey === undefined) return;
	const next: typeof container = { ...container };
	delete next.passkey;
	const version = await getMyKeyVersion(scope);
	next.masterKeyVersion = version;
	if (getAccountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await setKeyBackup(token, encodeServerBackup(next), version);
	notifyKeyMaterialChanged(scope);
}

export async function hasServerPasskeyBackup(token: string): Promise<boolean> {
	const { backup } = await getKeyBackup(token);
	return decodeServerBackup(backup)?.passkey !== undefined;
}

export function restoreWithServerPasskey(token: string): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () =>
		restoreWithServerPasskeyLocked(scope, token),
	);
}

async function restoreWithServerPasskeyLocked(
	scope: string,
	token: string,
): Promise<void> {
	const { backup } = await getKeyBackup(token);
	const wrapper = decodeServerBackup(backup)?.passkey;
	if (wrapper === undefined)
		throw new Error("passkey backup is not configured");
	const prf = await assertPasskey(
		fromBase64Url(wrapper.credentialId),
		fromBase64Url(wrapper.salt),
	);
	const data = await decryptBackupData(
		toBase64Url(new Uint8Array(prf)),
		wrapper.blob,
	);
	if (getAccountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await restoreServerBackupData(data, token);
}

export function disablePasskey(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => disablePasskeyLocked(scope));
}

async function disablePasskeyLocked(scope: string): Promise<void> {
	const pin = await hasPinLock(scope);
	if (!pin) {
		// Without another unlock factor the keys exist only in memory when
		// unlocked. Removing the last wrapper while they are locked would
		// leave nothing local to unlock.
		if (!isLocalLockUnlocked(scope)) throw new LocalLockRequiredError();
		const keyPair = await getMyKeyPair(scope);
		const identityKeyPair = await getIdentityKeyPair(scope);
		if (keyPair !== null && identityKeyPair !== null) {
			await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, keyPair.publicKey);
			await metaRepo.setNoNotifyFor(
				scope,
				PRIVATE_KEY_META,
				keyPair.privateKey,
			);
			await metaRepo.setNoNotifyFor(
				scope,
				IDENTITY_PUBLIC_KEY_META,
				identityKeyPair.publicKey,
			);
			await metaRepo.setNoNotifyFor(
				scope,
				IDENTITY_PRIVATE_KEY_META,
				identityKeyPair.privateKey,
			);
			await persistUnlockedHistory(scope);
		}
	}
	await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
	notifyKeyMaterialChanged(scope);
}
