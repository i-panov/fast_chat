import {
	deleteDeviceKeyBackup,
	deleteKeyBackup,
	getDeviceKeyBackup,
	getKeyBackup,
	getPublicKey,
	getUserDeviceKeys,
	registerDeviceKey,
	setDeviceKeyBackup,
	setKeyBackup,
	uploadPublicKey,
} from "../api.ts";
import { getActiveAccountKey, getDB } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { decryptBackup, encryptBackup } from "./backup.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";

const PRIVATE_KEY_META = "e2ee.privateKey";
const PUBLIC_KEY_META = "e2ee.publicKey";
const PUBLIC_KEY_UPLOADED_META = "e2ee.publicKeyUploaded";
const deviceKeyRegistered = new Set<string>();

// Security trade-off: the private key is stored in plaintext in the
// per-account IndexedDB (meta store) so messages stay decryptable across
// reloads without asking for a password every time. IndexedDB is
// same-origin: any XSS in the app can read it and with it the message
// history. Mitigations in place: the DB is per-account (no cross-account
// leak on switch), the in-memory mirror is scoped by account, and logout /
// "clear all data" must delete the account's database (see resetAllDBs and
// clearLocalKeys below). A stronger envelope (password-wrapped or
// non-extractable CryptoKey) would remove offline decryption; documented
// here instead of silently assuming IDB is safe.

// Throw when the account has no local key pair but a backup exists on the
// server, so the client asks the user to recover instead of silently
// generating a divergent key pair (which would orphan their old messages).
export class RecoveryRequiredError extends Error {
	constructor() {
		super("account keys are recoverable from a server backup");
	}
}

// Raised when a device has no local key and no server backup, but the account
// is active on other devices. Generating a fresh pair here would silently
// rotate the public key and make the other devices unable to read new
// messages, so the UI must ask the user to restore a backup or sign out
// everywhere first.

// Raised for the first key on a single-device account. Generating it makes
// old history unreadable, so the UI must ask before doing it.
export class KeyBackupCheckFailedError extends Error {
	constructor() {
		super("could not check the server key backup");
	}
}

export class NewKeyConfirmationRequiredError extends Error {
	constructor() {
		super("creating a new key pair needs an explicit confirmation");
	}
}

function pubKeyCacheKey(userId: string): string {
	return `e2ee.pubkey.${userId}`;
}

// Cached recipient public keys live at most this long before they are
// re-fetched, so a changed key on the server is picked up and the cache
// is refreshed instead of silently encrypting to a stale key forever.
const PUBKEY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPubKey {
	publicKey: string;
	keyVersion?: string;
	fetchedAt: number;
}

function isFreshCachedPubKey(value: unknown): value is CachedPubKey {
	if (value === null || typeof value !== "object") return false;
	const c = value as CachedPubKey;
	return (
		typeof c.publicKey === "string" &&
		c.publicKey !== "" &&
		typeof c.fetchedAt === "number" &&
		Date.now() - c.fetchedAt < PUBKEY_CACHE_TTL_MS
	);
}

// uploadPublicKeyIfNeeded uploads the account's public key to the server
// unless it has already been uploaded successfully. This heals cases where
// the server lost the key (DB reset) or the first upload failed.
async function uploadPublicKeyIfNeeded(
	token: string,
	publicKey: string,
): Promise<void> {
	const uploaded = await metaRepo.get(PUBLIC_KEY_UPLOADED_META);
	if (uploaded === true) return;

	try {
		await uploadPublicKey(token, publicKey);
		await metaRepo.setNoNotify(PUBLIC_KEY_UPLOADED_META, true);
	} catch (err) {
		console.warn("E2E public key upload failed, will retry:", err);
	}
}

async function ensureDeviceKey(
	token: string,
	publicKey: string,
): Promise<void> {
	const scope = `${accountScope()}:${token}`;
	if (deviceKeyRegistered.has(scope)) return;
	try {
		await registerDeviceKey(token, publicKey);
		deviceKeyRegistered.add(scope);
	} catch (err) {
		console.warn("E2E device key upload failed, will retry:", err);
	}
}

// Per-account in-memory caches. The active account key scopes them so
// switching accounts (a pure SPA transition, no reload) never leaks one
// account's key pair into another's requests. IndexedDB is already
// per-account; these mirrors keep repeated reads off the DB.
const keyCacheByAccount = new Map<string, KeyPair>();
const ACCOUNT_CHANGED = "account changed while creating the key";

type KeyLockManager = {
	request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

function withKeyLock<T>(scope: string, callback: () => Promise<T>): Promise<T> {
	const locks = (navigator as Navigator & { locks?: KeyLockManager }).locks;
	if (locks === undefined) return callback();
	return locks.request(`e2ee-key:${scope}`, callback);
}
const inFlightByAccount = new Map<string, Promise<KeyPair>>();
const inFlightIdByAccount = new Map<string, object>();

function accountScope(): string {
	return getActiveAccountKey() ?? "";
}

// --- Server key backup (recovery) ---------------------------------------

type BackupState = "none" | "backup" | "unknown";

// serverBackupState asks whether this account has a backup blob on the
// server. Distinguishes 404 (no backup) from other failures (unknown,
// e.g. offline) so we never clobber an existing backup when we cannot
// tell.
async function serverBackupState(token: string): Promise<BackupState> {
	try {
		const { backup } = await getKeyBackup(token);
		return backup !== "" ? "backup" : "none";
	} catch (err) {
		if (err instanceof Error && err.message.includes("http 404")) {
			return "none";
		}
		return "unknown";
	}
}

const RECOVERY_NEEDED_EVENT = "e2ee:recovery-needed";
const MULTI_DEVICE_KEY_EVENT = "e2ee:multi-device-key-required";
const NEW_KEY_EVENT = "e2ee:new-key-confirmation-needed";
const confirmedNewKey = new Set<string>();

// Emitted when the active account has no local keys but a backup exists on
// the server. The UI listens and shows a recovery prompt.
function emitRecoveryNeeded(token: string) {
	window.dispatchEvent(
		new CustomEvent<string>(RECOVERY_NEEDED_EVENT, { detail: token }),
	);
}

export function onRecoveryNeeded(fn: (token: string) => void): () => void {
	const handler = (e: Event) => {
		fn((e as CustomEvent<string>).detail);
	};
	window.addEventListener(RECOVERY_NEEDED_EVENT, handler);
	return () => window.removeEventListener(RECOVERY_NEEDED_EVENT, handler);
}

export function onMultiDeviceKeyRequired(
	fn: (token: string) => void,
): () => void {
	const handler = (e: Event) => {
		fn((e as CustomEvent<string>).detail);
	};
	window.addEventListener(MULTI_DEVICE_KEY_EVENT, handler);
	return () => window.removeEventListener(MULTI_DEVICE_KEY_EVENT, handler);
}

function emitNewKeyConfirmation(token: string) {
	window.dispatchEvent(
		new CustomEvent<string>(NEW_KEY_EVENT, { detail: token }),
	);
}

export function onNewKeyConfirmationNeeded(
	fn: (token: string) => void,
): () => void {
	const handler = (e: Event) => {
		fn((e as CustomEvent<string>).detail);
	};
	window.addEventListener(NEW_KEY_EVENT, handler);
	return () => window.removeEventListener(NEW_KEY_EVENT, handler);
}

// confirmNewKey records the user's explicit choice for the active account.
// The next ensureAccountKeys call may generate the pair.
export function confirmNewKey() {
	confirmedNewKey.add(accountScope());
}

// createNewKey performs the explicit "create a new key" action as one
// operation instead of confirm-then-retry racing with an old in-flight call.
export async function createNewKey(token: string): Promise<KeyPair> {
	const scope = accountScope();
	confirmNewKey();
	const pending = inFlightByAccount.get(scope);
	if (pending !== undefined) {
		// Let the already-running flight observe the confirmation. Do not
		// drop it: a second flight could generate a divergent key pair.
		await pending.catch(() => undefined);
	}
	if (accountScope() !== scope) {
		throw new Error(ACCOUNT_CHANGED);
	}
	return ensureAccountKeys(token);
}

// uploadKeyBackup encrypts the given key pair under the password and
// stores the blob on the server for cross-device recovery.
export async function uploadKeyBackup(
	token: string,
	password: string,
	kp: KeyPair,
	deviceID?: string,
): Promise<void> {
	const blob = await encryptBackup(password, kp);
	await setKeyBackup(token, blob);
	if (deviceID !== undefined) {
		await setDeviceKeyBackup(token, blob);
	}
}

// restoreKeyPairFromBackup fetches the server backup and recovers the key
// pair under the provided password. Throws E2EBackupError on a wrong
// password and saves the recovered pair locally on success.
export async function restoreKeyPairFromBackup(
	token: string,
	password: string,
): Promise<KeyPair> {
	const { backup } = await getKeyBackup(token);
	const kp = await decryptBackup(password, backup);
	await metaRepo.setNoNotify(PUBLIC_KEY_META, kp.publicKey);
	await metaRepo.setNoNotify(PRIVATE_KEY_META, kp.privateKey);
	await metaRepo.setNoNotify(PUBLIC_KEY_UPLOADED_META, true);
	keyCacheByAccount.set(accountScope(), kp);
	return kp;
}

// clearServerKeyBackup deletes the tracked user's backup blob (revocation
// or when the user starts fresh with a newly generated key pair).
export async function clearServerKeyBackup(
	token: string,
	deviceID?: string,
): Promise<void> {
	await deleteKeyBackup(token);
	if (deviceID !== undefined) {
		await deleteDeviceKeyBackup(token);
	}
}

// restoreKeyPairFromDeviceBackup recovers one device's key by password. The
// key is saved locally and re-registered for the current device, so a new
// browser can read the history addressed to that device.
export async function restoreKeyPairFromDeviceBackup(
	token: string,
	deviceID: string,
	password: string,
): Promise<KeyPair> {
	const { backup } = await getDeviceKeyBackup(token, deviceID);
	const kp = await decryptBackup(password, backup);
	await metaRepo.setNoNotify(PUBLIC_KEY_META, kp.publicKey);
	await metaRepo.setNoNotify(PRIVATE_KEY_META, kp.privateKey);
	await metaRepo.setNoNotify(PUBLIC_KEY_UPLOADED_META, true);
	keyCacheByAccount.set(accountScope(), kp);
	deviceKeyRegistered.delete(`${accountScope()}:${token}`);
	await ensureDeviceKey(token, kp.publicKey);
	return kp;
}

export async function hasServerKeyBackup(token: string): Promise<boolean> {
	return (await serverBackupState(token)) === "backup";
}

// discardRecoveryAndGenerate is chosen when the user declines to recover
// a server backup. The stale backup (which holds an older private key) is
// removed and a brand-new key pair is generated in its place.
export async function discardRecoveryAndGenerate(
	token: string,
): Promise<KeyPair> {
	await clearServerKeyBackup(token);
	confirmNewKey();
	return ensureAccountKeys(token);
}

// getMyKeyPair returns the account's E2E key pair from the local cache
// (per-account IndexedDB). Private keys never leave the device.
// Caches the key pair for the session to avoid repeated IDB reads.
export async function getMyKeyPair(): Promise<KeyPair | null> {
	const scope = accountScope();
	const cached = keyCacheByAccount.get(scope);
	if (cached !== undefined) return cached;

	const [publicKey, privateKey] = await Promise.all([
		metaRepo.get(PUBLIC_KEY_META),
		metaRepo.get(PRIVATE_KEY_META),
	]);

	if (typeof publicKey !== "string" || typeof privateKey !== "string") {
		return null;
	}

	const kp = { publicKey, privateKey };
	keyCacheByAccount.set(scope, kp);
	return kp;
}

// ensureAccountKeys generates a key pair on first use, uploads the
// public half to the server and persists both halves locally.
// Single-flight: the whole "no local key yet" decision (recovery check and
// generation) for an account is guarded, so concurrent calls share one
// in-flight operation. The server backup is queried and the recovery event
// is emitted at most once per racing burst.
export function ensureAccountKeys(token: string | undefined): Promise<KeyPair> {
	const scope = accountScope();
	const inFlight = inFlightByAccount.get(scope);
	if (inFlight !== undefined) {
		return inFlight;
	}

	const flightId = {};
	const run = (async () => {
		try {
			const existing = await getMyKeyPair();
			if (existing !== null) {
				// The key exists locally. Make sure the server has the
				// public half (retries after a failed upload or a server
				// DB reset).
				if (token !== undefined) {
					await uploadPublicKeyIfNeeded(token, existing.publicKey);
					await ensureDeviceKey(token, existing.publicKey);
				}
				return existing;
			}

			if (token === undefined) {
				throw new Error("cannot generate E2E keys without an active session");
			}

			// No local key pair. Before generating a brand-new pair, check
			// whether the server holds a backup for this account. If it
			// does, ask the user to recover instead of silently creating
			// divergent keys.
			const backupState = await serverBackupState(token);
			if (backupState === "unknown") {
				throw new KeyBackupCheckFailedError();
			}
			if (backupState === "backup") {
				emitRecoveryNeeded(token);
				throw new RecoveryRequiredError();
			}

			// Phase B: this device gets its own key. The user still has to
			// confirm, because old messages addressed to the account key (or
			// to another device) will stay unreadable here.
			if (!confirmedNewKey.has(scope)) {
				emitNewKeyConfirmation(token);
				throw new NewKeyConfirmationRequiredError();
			}
			confirmedNewKey.delete(scope);
			if (accountScope() !== scope) {
				throw new Error(ACCOUNT_CHANGED);
			}

			const kp = await withKeyLock(scope, async () => {
				// Another tab may have generated the key while this flight
				// was waiting for the lock. Re-read without the stale cache.
				keyCacheByAccount.delete(scope);
				const raced = await getMyKeyPair();
				if (raced !== null) return raced;
				if (accountScope() !== scope) {
					throw new Error(ACCOUNT_CHANGED);
				}
				const generated = await generateKeyPair();
				if (accountScope() !== scope) {
					throw new Error(ACCOUNT_CHANGED);
				}
				// Save locally first so decryption works even if the server
				// is unreachable; the upload is retried on later calls.
				await metaRepo.setNoNotify(PUBLIC_KEY_META, generated.publicKey);
				await metaRepo.setNoNotify(PRIVATE_KEY_META, generated.privateKey);
				await metaRepo.setNoNotify(PUBLIC_KEY_UPLOADED_META, false);
				keyCacheByAccount.set(scope, generated);
				await uploadPublicKeyIfNeeded(token, generated.publicKey);
				await ensureDeviceKey(token, generated.publicKey);
				return generated;
			});
			return kp;
		} finally {
			if (inFlightIdByAccount.get(scope) === flightId) {
				inFlightByAccount.delete(scope);
				inFlightIdByAccount.delete(scope);
			}
		}
	})();

	inFlightByAccount.set(scope, run);
	inFlightIdByAccount.set(scope, flightId);
	return run;
}

// getRecipientPublicKey returns another user's public key, fetching and
// caching it from the server (transparently proxying federated users).
// The cache expires after a few minutes so key changes are picked up.
async function getRecipientPublicKey(
	token: string,
	userId: string,
): Promise<string> {
	const cached = await metaRepo.get(pubKeyCacheKey(userId));
	if (isFreshCachedPubKey(cached)) {
		return cached.publicKey;
	}

	const { publicKey, keyVersion } = await getPublicKey(token, userId);
	await metaRepo.setNoNotify(pubKeyCacheKey(userId), {
		publicKey,
		keyVersion,
		fetchedAt: Date.now(),
	});

	return publicKey;
}

// clearLocalKeys drops the cached key pair and removes both halves from the
// active account's IndexedDB. Call it on logout / account removal so the next
// user of the device cannot recover the previous account's private key from
// the local database.
export async function clearLocalKeys(): Promise<void> {
	const scope = accountScope();
	keyCacheByAccount.delete(scope);
	inFlightByAccount.delete(scope);
	inFlightIdByAccount.delete(scope);
	confirmedNewKey.delete(scope);
	const db = await getDB();
	await Promise.all([
		db.delete("meta", PUBLIC_KEY_META),
		db.delete("meta", PRIVATE_KEY_META),
		db.delete("meta", PUBLIC_KEY_UPLOADED_META),
	]).catch(() => {});
}

// getRecipientDeviceKeys returns the active device keys of every member.
// Users with no registered devices fall back to the legacy account key with
// keyId=userId, so old clients keep receiving envelopes.
export async function getRecipientDeviceKeys(
	token: string,
	userIds: string[],
): Promise<Map<string, Array<{ keyId: string; publicKey: string }>>> {
	const out = new Map<string, Array<{ keyId: string; publicKey: string }>>();
	await Promise.all(
		userIds.map(async (userId) => {
			const keys: Array<{ keyId: string; publicKey: string }> = [];
			try {
				const { devices } = await getUserDeviceKeys(token, userId);
				for (const device of devices) {
					keys.push({ keyId: device.id, publicKey: device.publicKey });
				}
			} catch {
				// Fall through to the legacy account key.
			}
			try {
				// Always include the account key as a legacy envelope: a client
				// that predates device keys does not register one and can only
				// read keyId=userId.
				const publicKey = await getRecipientPublicKey(token, userId);
				if (
					publicKey !== "" &&
					!keys.some((key) => key.publicKey === publicKey)
				) {
					keys.push({ keyId: userId, publicKey });
				}
			} catch {
				// The caller reports the missing key.
			}
			if (keys.length > 0) out.set(userId, keys);
		}),
	);
	return out;
}
