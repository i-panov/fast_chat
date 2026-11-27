import { metaRepo } from "../db/metaRepo.ts";
import { clearDecryptedFileCache } from "../utils/fileCache.ts";
import { decryptBackupData, encryptBackupData } from "./backup.ts";
import { samePublicKey } from "./crypto.ts";
import {
	getAccountScope,
	getIdentityChain,
	getIdentityHistory,
	getIdentityKeyPair,
	getKeyHistory,
	getMyKeyPair,
	getMyKeyVersion,
	IDENTITY_CHAIN_META,
	IDENTITY_HISTORY_META,
	IDENTITY_PRIVATE_KEY_META,
	IDENTITY_PUBLIC_KEY_META,
	isLocalLockUnlocked,
	KEY_HISTORY_META,
	KEY_VERSION_META,
	LOCAL_LOCK_CHANGED_EVENT,
	LOCAL_LOCK_META,
	LocalLockRequiredError,
	lockLocalKeys,
	notifyKeyMaterialChanged,
	PASSKEY_LOCK_META,
	PRIVATE_KEY_META,
	PUBLIC_KEY_META,
	persistUnlockedHistory,
	setUnlockedMasterKeys,
	withAccountKeyLock,
} from "./keys.ts";
import { listenForLockRequests, postLockRequest } from "./localLockChannel.ts";
import { hasPasskeyLock } from "./passkeyLock.ts";

const PIN_PATTERN = /^\d{6}$/;

async function removePlaintextKeys(scope: string): Promise<void> {
	await Promise.all([
		metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, PRIVATE_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_PUBLIC_KEY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_PRIVATE_KEY_META, null),
	]);
}

export function enableLocalPin(pin: string): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => enableLocalPinLocked(scope, pin));
}

async function enableLocalPinLocked(scope: string, pin: string): Promise<void> {
	if (!PIN_PATTERN.test(pin)) throw new Error("PIN must be 6 digits");
	const keyPair = await getMyKeyPair(scope);
	const identityKeyPair = await getIdentityKeyPair(scope);
	if (keyPair === null || identityKeyPair === null) {
		throw new Error("no local keys to protect");
	}
	const blob = await encryptBackupData(pin, {
		keyPair,
		identityKeyPair,
		keyVersion: await getMyKeyVersion(scope),
		keyHistory: await getKeyHistory(scope),
		identityHistory: await getIdentityHistory(scope),
		identityChain: await getIdentityChain(scope),
	});
	if (getAccountScope() !== scope) throw new Error("account changed");
	await metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, blob);
	// Verify the stored blob opens before deleting the only plaintext copy:
	// a malformed write would otherwise leave the account recoverable only
	// through the server backup.
	try {
		const stored = await metaRepo.getFor(scope, LOCAL_LOCK_META);
		const check = await decryptBackupData(
			pin,
			typeof stored === "string" ? stored : "",
		);
		if (
			!samePublicKey(check.keyPair.publicKey, keyPair.publicKey) ||
			!samePublicKey(check.identityKeyPair.publicKey, identityKeyPair.publicKey)
		) {
			throw new Error("local lock verification failed");
		}
	} catch (err) {
		// Never leave a lock blob that does not open next to plaintext keys.
		await metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, null);
		throw err;
	}
	await Promise.all([
		removePlaintextKeys(scope),
		metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, null),
		clearDecryptedFileCache(scope === "" ? null : scope),
	]);
	notifyKeyMaterialChanged(scope);
}

export function unlockLocalPin(pin: string): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => unlockLocalPinLocked(scope, pin));
}

async function unlockLocalPinLocked(scope: string, pin: string): Promise<void> {
	const blob = await metaRepo.getFor(scope, LOCAL_LOCK_META);
	if (typeof blob !== "string" || blob === "") {
		throw new Error("local lock is not configured");
	}
	const data = await decryptBackupData(pin, blob);
	await setUnlockedMasterKeys(data, scope);
	notifyKeyMaterialChanged(scope);
}

export function disableLocalPin(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => disableLocalPinLocked(scope));
}

async function disableLocalPinLocked(scope: string): Promise<void> {
	if (!isLocalLockUnlocked(scope)) throw new LocalLockRequiredError();
	// A passkey lock may still be enabled: removing the PIN must not write
	// plaintext keys behind its back.
	if (!(await hasPasskeyLock(scope))) {
		const keyPair = await getMyKeyPair(scope);
		const identityKeyPair = await getIdentityKeyPair(scope);
		if (keyPair === null || identityKeyPair === null) return;
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, keyPair.publicKey);
		await metaRepo.setNoNotifyFor(scope, PRIVATE_KEY_META, keyPair.privateKey);
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
	await metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, null);
	notifyKeyMaterialChanged(scope);
}

export function clearLocalLockAndKeys(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => clearLocalLockAndKeysLocked(scope));
}

async function clearLocalLockAndKeysLocked(scope: string): Promise<void> {
	await metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, null);
	await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
	await removePlaintextKeys(scope);
	await clearDecryptedFileCache(scope === "" ? null : scope);
	await Promise.all([
		metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, null),
		metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, null),
	]);
	// lockLocalKeys clears the in-memory copies and fires the change event.
	lockLocalKeys(scope);
	// Other tabs must drop their in-memory keys too after a wipe.
	notifyKeyMaterialChanged(scope);
}

// requestLocalLock is the explicit "lock now" action: it forgets this tab's
// in-memory keys and asks the other tabs of the same account to do the same.
// The disk state does not change — the keys are already wrapped there.
export function requestLocalLock(notifyTabs = true): void {
	const scope = getAccountScope();
	lockLocalKeys(scope);
	if (notifyTabs) postLockRequest(scope);
}

// subscribeToRemoteLock locks this tab when another tab locks the account.
export function subscribeToRemoteLock(): () => void {
	return listenForLockRequests((scope) => {
		if (scope === getAccountScope()) lockLocalKeys(scope);
	});
}

export function onLocalLockChanged(listener: () => void): () => void {
	window.addEventListener(LOCAL_LOCK_CHANGED_EVENT, listener);
	return () => window.removeEventListener(LOCAL_LOCK_CHANGED_EVENT, listener);
}
