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
	getLockEpoch,
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

// The PIN length is part of the crypto contract; the settings UI imports
// this validator so the two cannot drift apart.
export const LOCAL_PIN_PATTERN = /^\d{6}$/;
const PIN_PATTERN = LOCAL_PIN_PATTERN;

// A 6-digit PIN carries ~20 bits, so an obvious one is guessable even
// without the offline KDF. Reject the blocklist before wrapping a key.
const WEAK_PINS = new Set([
	"000000",
	"111111",
	"123123",
	"121212",
	"112233",
	"147258",
	"159753",
	"654321",
	"696969",
	"777777",
	"987654",
]);

export function isWeakLocalPin(pin: string): boolean {
	if (!PIN_PATTERN.test(pin)) return true;
	if (WEAK_PINS.has(pin)) return true;
	const digits = [...pin].map(Number);
	if (new Set(digits).size === 1) return true;
	const ascending = digits.every(
		(digit, index) => index === 0 || digit === digits[index - 1] + 1,
	);
	const descending = digits.every(
		(digit, index) => index === 0 || digit === digits[index - 1] - 1,
	);
	return ascending || descending;
}

export class WeakLocalPinError extends Error {
	constructor() {
		super("local PIN is too weak");
	}
}

// Repeated wrong PINs are throttled in the local store. This cannot stop an
// attacker who copies IndexedDB, but it stops guessing at a borrowed device.
const LOCK_FAILURES_META = "e2ee.localLockFailures";
const THROTTLE_AFTER_FAILURES = 3;
const THROTTLE_STEP_MS = 5_000;
const THROTTLE_MAX_MS = 5 * 60_000;

interface LockFailures {
	count: number;
	lastFailedAt: number;
}

export class LocalLockThrottledError extends Error {
	readonly retryAfterSeconds: number;

	constructor(retryAfterSeconds: number) {
		super("too many wrong PIN attempts");
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

async function readLockFailures(scope: string): Promise<LockFailures> {
	const raw = await metaRepo.getFor(scope, LOCK_FAILURES_META);
	if (typeof raw !== "object" || raw === null)
		return { count: 0, lastFailedAt: 0 };
	const value = raw as Partial<LockFailures>;
	return {
		count: typeof value.count === "number" && value.count > 0 ? value.count : 0,
		lastFailedAt:
			typeof value.lastFailedAt === "number" ? value.lastFailedAt : 0,
	};
}

async function assertNotThrottled(scope: string): Promise<void> {
	const failures = await readLockFailures(scope);
	if (failures.count < THROTTLE_AFTER_FAILURES) return;
	const waitMs = Math.min(
		THROTTLE_MAX_MS,
		THROTTLE_STEP_MS * 2 ** (failures.count - THROTTLE_AFTER_FAILURES),
	);
	const elapsed = Date.now() - failures.lastFailedAt;
	if (elapsed < waitMs) {
		throw new LocalLockThrottledError(
			Math.max(1, Math.ceil((waitMs - elapsed) / 1000)),
		);
	}
}

async function recordLockFailure(scope: string): Promise<void> {
	const failures = await readLockFailures(scope);
	await metaRepo.setNoNotifyFor(scope, LOCK_FAILURES_META, {
		count: failures.count + 1,
		lastFailedAt: Date.now(),
	});
}

async function clearLockFailures(scope: string): Promise<void> {
	await metaRepo.setNoNotifyFor(scope, LOCK_FAILURES_META, null);
}

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
	if (isWeakLocalPin(pin)) throw new WeakLocalPinError();
	const keyPair = await getMyKeyPair(scope);
	const identityKeyPair = await getIdentityKeyPair(scope);
	if (keyPair === null || identityKeyPair === null) {
		throw new Error("no local keys to protect");
	}
	const previousBlob = await metaRepo.getFor(scope, LOCAL_LOCK_META);
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
		// A previous working wrapper (change-PIN flow) must survive the
		// failure instead of being erased with the new one.
		await metaRepo.setNoNotifyFor(
			scope,
			LOCAL_LOCK_META,
			typeof previousBlob === "string" && previousBlob !== ""
				? previousBlob
				: null,
		);
		throw err;
	}
	await clearLockFailures(scope);
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
	await assertNotThrottled(scope);
	// Capture the epoch before the slow KDF: a remote lock or "lock now"
	// during it must win over the decrypted key.
	const epoch = getLockEpoch(scope);
	let data: Awaited<ReturnType<typeof decryptBackupData>>;
	try {
		data = await decryptBackupData(pin, blob);
	} catch (err) {
		await recordLockFailure(scope);
		throw err;
	}
	await setUnlockedMasterKeys(data, scope, epoch);
	await clearLockFailures(scope);
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
	await clearLockFailures(scope);
	notifyKeyMaterialChanged(scope);
}

export function clearLocalLockAndKeys(): Promise<void> {
	const scope = getAccountScope();
	return withAccountKeyLock(scope, () => clearLocalLockAndKeysLocked(scope));
}

async function clearLocalLockAndKeysLocked(scope: string): Promise<void> {
	await metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, null);
	await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
	await clearLockFailures(scope);
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
