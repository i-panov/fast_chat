/* eslint-disable max-lines -- the key lifecycle, backup and local-lock API share one module boundary. */
import {
	deleteKeyBackup,
	getKeyBackup,
	getPublicKey,
	setKeyBackup,
	uploadPublicKey,
} from "../api.ts";
import { getActiveAccountKey, getDBFor } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { clearDecryptedFileCache } from "../utils/fileCache.ts";
import type { IdentityRotation, KeyHistoryEntry } from "./backup.ts";
import {
	type BackupData,
	decodeServerBackup,
	decryptBackupData,
	E2EBackupError,
	encodeServerBackup,
	encryptBackupData,
	type PasskeyBackupWrapper,
} from "./backup.ts";
import {
	generateIdentityKeyPair,
	generateKeyPair,
	type IdentityKeyPair,
	type KeyPair,
	samePublicKey,
	signSenderBinding,
} from "./crypto.ts";

export const PRIVATE_KEY_META = "e2ee.privateKey";
export const PUBLIC_KEY_META = "e2ee.publicKey";
export const PUBLIC_KEY_UPLOADED_META = "e2ee.publicKeyUploaded";
export const IDENTITY_PRIVATE_KEY_META = "e2ee.identityPrivateKey";
export const IDENTITY_PUBLIC_KEY_META = "e2ee.identityPublicKey";
export const KEY_VERSION_META = "e2ee.keyVersion";
export const KEY_HISTORY_META = "e2ee.keyHistory";
export const IDENTITY_HISTORY_META = "e2ee.identityHistory";
export const IDENTITY_CHAIN_META = "e2ee.identityChain";
export const LOCAL_LOCK_META = "e2ee.localLock";
export const PASSKEY_LOCK_META = "e2ee.passkeyLock";
export const LOCAL_LOCK_CHANGED_EVENT = "fastchat-local-lock-changed";

// Key material changes (lock/unlock, creation, restore, rotation) invalidate
// cached decryption results, so every such transition emits one event.
export const KEY_MATERIAL_CHANNEL = "fastchat-key-material";
// BroadcastChannel delivers to other objects in the same tab as well; a
// per-tab id lets the listener ignore its own notifications.
export const KEY_TAB_ID = crypto.randomUUID();

function notifyLocalKeyMaterialChanged(): void {
	keyVersionCache.clear();
	window.dispatchEvent(new Event(LOCAL_LOCK_CHANGED_EVENT));
}

export function notifyKeyMaterialChanged(scope: string = accountScope()): void {
	notifyLocalKeyMaterialChanged();
	try {
		if (typeof BroadcastChannel !== "undefined") {
			const channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
			channel.postMessage({ scope, tabId: KEY_TAB_ID });
			channel.close();
		}
	} catch {
		// Best-effort cross-tab notification.
	}
}

// invalidateKeyMaterialCaches drops this tab's in-memory mirrors after
// another tab rotated/created/restored the key.
export function invalidateKeyMaterialCaches(
	scope: string = accountScope(),
): void {
	keyCacheByAccount.delete(scope);
	identityCacheByAccount.delete(scope);
	keyHistoryByAccount.delete(scope);
	identityHistoryByAccount.delete(scope);
	identityChainByAccount.delete(scope);
	inFlightByAccount.delete(scope);
	keyVersionCache.delete(scope);
	window.dispatchEvent(new Event(LOCAL_LOCK_CHANGED_EVENT));
}

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

// Raised before any key access when the account has a local PIN lock and the
// keys have not been unlocked in this session.
export class LocalLockRequiredError extends Error {
	constructor() {
		super("local key lock is closed");
	}
}

// Raised when a key operation cannot run while a local unlock factor is
// configured, instead of silently bypassing that factor.
export class LocalLockEnabledError extends Error {
	constructor() {
		super("disable PIN/passkey before rotating the key");
	}
}

// Raised when a rotation would orphan the passkey wrapper of the server
// backup: without the password the new key would be unrecoverable.
export class PasskeyBackupEnabledError extends Error {
	constructor() {
		super("disable passkey backup before rotating the key");
	}
}

// Raised when this device's local key does not correspond to the key the
// server currently publishes (another device rotated or the backup is
// newer). Rotating or saving a backup in this state would overwrite the
// current master key, so the user has to recover first.
export class StaleKeyStateError extends Error {
	constructor() {
		super("local key state is behind the server; restore the backup first");
	}
}

// Raised when the new public key could not be published. The local key is
// already persisted so a later retry can publish the same version.
export class KeyPublishError extends Error {
	readonly code: string | undefined;

	constructor(cause?: unknown) {
		super("could not publish the new public key");
		this.code =
			typeof cause === "object" && cause !== null && "code" in cause
				? (cause as { code?: string }).code
				: undefined;
	}
}

// Raised when the key was published but its backup was not written. The
// rotation itself succeeded; the user must save the backup again so another
// device can recover the current key.
export class KeyBackupSaveError extends Error {
	readonly code: string | undefined;

	constructor(cause?: unknown) {
		super("key was rotated but the backup could not be saved");
		this.code =
			typeof cause === "object" && cause !== null && "code" in cause
				? (cause as { code?: string }).code
				: undefined;
	}
}

// Identity rotations embedded in every message must stay bounded. Each link
// adds to the payload; an unbounded chain eventually exceeds the server's
// encrypted-payload limit and makes sending fail.
const MAX_IDENTITY_CHAIN_LENGTH = 32;
// Bound the recoverable history so the encrypted backup stays under the
// server's 128 KiB limit even with password and passkey wrappers.
const MAX_KEY_HISTORY_LENGTH = 64;
const MAX_IDENTITY_HISTORY_LENGTH = 64;

function pubKeyCacheKey(userId: string): string {
	return `e2ee.pubkey.${userId}`;
}

// Cached recipient public keys live at most this long before they are
// re-fetched, so a changed key on the server is picked up and the cache
// is refreshed instead of silently encrypting to a stale key forever.
const PUBKEY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CachedPubKey {
	publicKey: string;
	keyVersion: number;
	fetchedAt: number;
}

function isFreshCachedPubKey(value: unknown): value is CachedPubKey {
	if (value === null || typeof value !== "object") return false;
	const c = value as CachedPubKey;
	return (
		typeof c.publicKey === "string" &&
		c.publicKey !== "" &&
		typeof c.keyVersion === "number" &&
		typeof c.fetchedAt === "number" &&
		Date.now() - c.fetchedAt < PUBKEY_CACHE_TTL_MS
	);
}

// uploadPublicKeyIfNeeded uploads the account's public key to the server
// unless it has already been uploaded successfully. This heals cases where
// the server lost the key (DB reset) or the first upload failed.
async function uploadPublicKeyIfNeeded(
	scope: string,
	token: string,
): Promise<void> {
	const uploaded = await metaRepo.getFor(scope, PUBLIC_KEY_UPLOADED_META);
	if (uploaded === true) return;

	try {
		const current = await getMyKeyPair(scope);
		if (current === null) return;
		const identity = await ensureIdentityKeys(scope);
		if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
		await uploadPublicKey(
			token,
			current.publicKey,
			identity.publicKey,
			await getMyKeyVersion(scope),
		);
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, true);
	} catch (err) {
		if (err instanceof Error && err.message === ACCOUNT_CHANGED) throw err;
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		if (message.includes("409") || message.includes("stale")) {
			// Another device published a newer key. Keeping the local one
			// would encrypt to a key the server no longer advertises.
			emitRecoveryNeeded(token);
			throw new StaleKeyStateError();
		}
		console.warn("E2E public key upload failed, will retry:", err);
	}
}

// Per-account in-memory caches. The active account key scopes them so
// switching accounts (a pure SPA transition, no reload) never leaks one
// account's key pair into another's requests. IndexedDB is already
// per-account; these mirrors keep repeated reads off the DB.
const keyCacheByAccount = new Map<string, KeyPair>();
const identityCacheByAccount = new Map<string, IdentityKeyPair>();
// Key and identity history is secret (old private keys). When a local lock is
// enabled it lives only inside the encrypted blob, so the decrypted copy is
// kept in memory instead of being written back to IndexedDB.
const keyHistoryByAccount = new Map<string, KeyHistoryEntry[]>();
const identityHistoryByAccount = new Map<string, string[]>();
const identityChainByAccount = new Map<string, IdentityRotation[]>();
const keyVersionCache = new Map<string, number>();
// A discarded recovery keeps the server's old version, so the replacement
// key must start above it instead of colliding at version 1.
const forcedVersionByAccount = new Map<string, number>();
// Incremented when the lock closes (or local keys are cleared). A generation
// started before that point must not write plaintext keys afterwards.
const lockEpochByAccount = new Map<string, number>();
const identityInFlightByAccount = new Map<string, Promise<IdentityKeyPair>>();
const ACCOUNT_CHANGED = "account changed while creating the key";

type KeyLockManager = {
	request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

function withNamedLock<T>(
	name: string,
	callback: () => Promise<T>,
): Promise<T> {
	const locks = (navigator as Navigator & { locks?: KeyLockManager }).locks;
	if (locks === undefined) return callback();
	return locks.request(name, callback);
}

function withKeyLock<T>(scope: string, callback: () => Promise<T>): Promise<T> {
	return withNamedLock(`e2ee-key:${scope}`, callback);
}

// Lock operations (PIN/passkey enable/disable/unlock) share this lock with
// rotations so a blob cannot wrap a key that is being replaced concurrently.
export function withAccountKeyLock<T>(
	scope: string,
	callback: () => Promise<T>,
): Promise<T> {
	return withKeyLock(scope, callback);
}

function lockEpoch(scope: string): number {
	return lockEpochByAccount.get(scope) ?? 0;
}

// getLockEpoch lets async decryption detect a lock that closed before React
// committed the state update.
export function getLockEpoch(scope: string = accountScope()): number {
	return lockEpoch(scope);
}

function assertLockEpoch(scope: string, epoch: number): void {
	if (lockEpoch(scope) !== epoch) throw new LocalLockRequiredError();
}

// Identity generation may happen while the device-key lock is already held
// (the first upload includes both public halves), so it uses its own lock.
function withIdentityLock<T>(
	scope: string,
	callback: () => Promise<T>,
): Promise<T> {
	return withNamedLock(`e2ee-identity:${scope}`, callback);
}
const inFlightByAccount = new Map<string, Promise<KeyPair>>();
const inFlightIdByAccount = new Map<string, object>();

function accountScope(): string {
	return getActiveAccountKey() ?? "";
}

// getAccountScope exposes the captured scope for modules that must pin
// destructive lock operations to one account.
export function getAccountScope(): string {
	return accountScope();
}

// getIdentityKeyPair returns this account's long-lived Ed25519 identity.
// Unlike the device key it does not change when the browser creates a new
// X25519 pair: recipients pin it once and accept messages from every device
// restored from the same password backup.
export async function getIdentityKeyPair(
	scope: string = accountScope(),
): Promise<IdentityKeyPair | null> {
	const cached = identityCacheByAccount.get(scope);
	if (cached !== undefined) return cached;

	const [publicKey, privateKey] = await Promise.all([
		metaRepo.getFor(scope, IDENTITY_PUBLIC_KEY_META),
		metaRepo.getFor(scope, IDENTITY_PRIVATE_KEY_META),
	]);
	if (typeof publicKey !== "string" || typeof privateKey !== "string") {
		return null;
	}
	const kp = { publicKey, privateKey };
	identityCacheByAccount.set(scope, kp);
	return kp;
}

// ensureIdentityKeys creates the identity on first use. Single-flight per
// account: two concurrent sends must not generate two different identities.
export function ensureIdentityKeys(
	scope: string = accountScope(),
): Promise<IdentityKeyPair> {
	const inFlight = identityInFlightByAccount.get(scope);
	if (inFlight !== undefined) return inFlight;

	const run = (async () => {
		// A closed lock means the identity lives only in the encrypted blob;
		// generating a new one here would write its private half in plaintext
		// and silently break the backup history.
		if ((await hasLocalLock(scope)) && !isLocalLockUnlocked(scope)) {
			throw new LocalLockRequiredError();
		}
		const existing = await getIdentityKeyPair(scope);
		if (existing !== null) return existing;

		return withIdentityLock(scope, async () => {
			const epoch = lockEpoch(scope);
			identityCacheByAccount.delete(scope);
			const raced = await getIdentityKeyPair(scope);
			if (raced !== null) return raced;
			if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
			const generated = await generateIdentityKeyPair();
			if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
			// The lock may have closed while the key was being generated;
			// writing it now would bypass the lock and reopen the session.
			assertLockEpoch(scope, epoch);
			if ((await hasLocalLock(scope)) && !isLocalLockUnlocked(scope)) {
				throw new LocalLockRequiredError();
			}
			await storeIdentityKeyPair(generated, scope);
			return generated;
		});
	})().finally(() => identityInFlightByAccount.delete(scope));

	identityInFlightByAccount.set(scope, run);
	return run;
}

async function storeIdentityKeyPair(
	kp: IdentityKeyPair,
	scope: string,
): Promise<void> {
	await metaRepo.setNoNotifyFor(scope, IDENTITY_PUBLIC_KEY_META, kp.publicKey);
	await metaRepo.setNoNotifyFor(
		scope,
		IDENTITY_PRIVATE_KEY_META,
		kp.privateKey,
	);
	// The server needs the identity half too; force the next upload to carry it.
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, false);
	identityCacheByAccount.set(scope, kp);
}

// --- Server key backup (recovery) ---------------------------------------

type BackupState =
	| "none"
	| "backup"
	| "legacy"
	| "stale"
	| "local-stale"
	| "unknown";

// serverBackupState asks whether this account has a backup blob on the
// server. Distinguishes 404 (no backup) from other failures (unknown,
// e.g. offline) so we never clobber an existing backup when we cannot
// tell.
export async function getServerBackupState(
	token: string,
	scope: string = accountScope(),
): Promise<BackupState> {
	try {
		const { backup } = await getKeyBackup(token);
		if (backup === "") return "none";
		const container = decodeServerBackup(backup);
		// A legacy/incompatible blob cannot be opened by this client. Keep it
		// distinct from "no backup" so the UI can say the old one is unusable
		// instead of silently overwriting it.
		if (container === null) return "legacy";
		if (container.password === undefined && container.passkey === undefined) {
			return "legacy";
		}
		// A backup from before/after a rotation on another device is not a
		// usable recovery source for the current key.
		if (container.masterKeyVersion !== undefined) {
			const localVersion = await getMyKeyVersion(scope);
			if (container.masterKeyVersion < localVersion) return "stale";
			if (container.masterKeyVersion > localVersion) return "local-stale";
		}
		return "backup";
	} catch (err) {
		if (err instanceof Error && err.message.includes("http 404")) {
			return "none";
		}
		return "unknown";
	}
}

const RECOVERY_NEEDED_EVENT = "e2ee:recovery-needed";
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

	try {
		return await ensureAccountKeys(token);
	} catch (err) {
		if (!(err instanceof NewKeyConfirmationRequiredError)) throw err;
		// A concurrent caller claimed the confirmation between the click and
		// this flight. The user already confirmed, so ask once more instead
		// of leaving the dialog open as if the button did nothing.
		confirmNewKey();

		return ensureAccountKeys(token);
	}
}

// uploadKeyBackup encrypts the current local master key under the password
// and stores it for cross-device recovery.
export function uploadKeyBackup(
	token: string,
	password: string,
): Promise<void> {
	const scope = accountScope();
	return withKeyLock(scope, () =>
		uploadKeyBackupLocked(scope, token, password),
	);
}

async function uploadKeyBackupLocked(
	scope: string,
	token: string,
	password: string,
): Promise<void> {
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	const currentKey = await getMyKeyPair(scope);
	if (currentKey === null) throw new LocalLockRequiredError();
	const identityKeyPair = await ensureIdentityKeys(scope);
	const version = await getMyKeyVersion(scope);
	// If a previous rotation persisted the key locally but failed to publish
	// it, retry that publication before writing a backup with the newer
	// version (the server rejects backups for an unpublished version).
	const server = await readServerKeyState(token, scope);
	if (server.version > version) throw new StaleKeyStateError();
	if (
		server.publicKey === "" ||
		server.version < version ||
		server.identityPublicKey === ""
	) {
		try {
			await uploadPublicKey(
				token,
				currentKey.publicKey,
				identityKeyPair.publicKey,
				version,
			);
			await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, true);
		} catch (err) {
			throw new KeyPublishError(err);
		}
	}
	// A matching local version is not enough: the server may publish a
	// different key at that version. Writing the orphan key here would
	// destroy the recovery source of the real one.
	await assertServerKeyMatchesLocal(token, currentKey, version, scope);
	const blob = await encryptBackupData(password, {
		keyPair: currentKey,
		identityKeyPair,
		keyVersion: version,
		keyHistory: await getKeyHistory(scope),
		identityHistory: await getIdentityHistory(scope),
		identityChain: await getIdentityChain(scope),
	});
	// Password changes must not drop the passkey wrapper: the master key is
	// unchanged, so the existing passkey blob stays valid.
	let passkey: PasskeyBackupWrapper | undefined;
	try {
		const current = await getKeyBackup(token);
		passkey = decodeServerBackup(current.backup)?.passkey;
	} catch (err) {
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		if (!message.includes("404") && !message.includes("not found")) {
			// A transient read failure must not silently discard the passkey
			// wrapper: leaving the old blob is safer than overwriting it.
			throw err;
		}
	}
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await setKeyBackup(
		token,
		encodeServerBackup({
			v: 4,
			masterKeyVersion: version,
			password: blob,
			passkey,
		}),
		version,
	);
}

interface ServerKeyState {
	publicKey: string;
	identityPublicKey: string;
	version: number;
}

async function readServerKeyState(
	token: string,
	userId: string,
): Promise<ServerKeyState> {
	try {
		const { publicKey, identityPublicKey, masterKeyVersion } =
			await getPublicKey(token, userId);
		return {
			publicKey,
			identityPublicKey,
			version: masterKeyVersion >= 1 ? masterKeyVersion : 1,
		};
	} catch (err) {
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		// No published key yet: the caller can upload one or restore.
		if (message.includes("404") || message.includes("not found")) {
			return { publicKey: "", identityPublicKey: "", version: 1 };
		}
		throw err;
	}
}

const lastStaleReportByScope = new Map<string, number>();

// reportStaleEnvelopeVersion is called when no local key opens an envelope
// whose version is above ours. If the server has moved on, another device
// rotated the key: tell the UI so the user can recover instead of silently
// seeing "undecryptable" forever. Throttled because decryption runs per row.
export async function reportStaleEnvelopeVersion(
	version: number,
): Promise<void> {
	const scope = accountScope();
	if (version <= (await getMyKeyVersion(scope))) return;
	// With a local lock the recovery prompt could not restore anything
	// (plaintext restore is refused) and has no safe escape; leave the
	// message undecryptable instead of trapping the user in that dialog.
	if ((await hasLocalLock(scope)) && !isLocalLockUnlocked(scope)) return;
	const now = Date.now();
	if (now - (lastStaleReportByScope.get(scope) ?? 0) < 60_000) return;
	lastStaleReportByScope.set(scope, now);
	let token: string | null = null;
	try {
		// A fresh tab may not have written sessionStorage yet; the persistent
		// mirror is written at login.
		token =
			sessionStorage.getItem("activeToken") ??
			localStorage.getItem("activeToken");
	} catch {
		return;
	}
	if (token === null) return;
	try {
		const server = await readServerKeyState(token, scope);
		if (server.version > (await getMyKeyVersion(scope))) {
			emitRecoveryNeeded(token);
		}
	} catch {
		// Offline or the peer stopped serving the key: keep the placeholder.
	}
}

// assertServerKeyMatchesLocal rejects a rotation from a device that missed
// another device's rotation. The server may still be one version behind a
// pending upload, but it must know the local key or one from its history.
async function assertServerKeyMatchesLocal(
	token: string,
	local: KeyPair,
	localVersion: number,
	scope: string = accountScope(),
): Promise<ServerKeyState> {
	const server = await readServerKeyState(token, scope);
	if (server.publicKey === "") return server;
	if (server.version > localVersion) throw new StaleKeyStateError();
	if (samePublicKey(server.publicKey, local.publicKey)) return server;
	// A history match only explains a *lagging* server. At the same version
	// a different key is a conflict, not a pending upload.
	if (server.version < localVersion) {
		const history = await getKeyHistory(scope);
		if (
			history.some((entry) =>
				samePublicKey(entry.keyPair.publicKey, server.publicKey),
			)
		) {
			return server;
		}
	}
	throw new StaleKeyStateError();
}

// assertLocalKeyMatchesServer is used before writing any secondary wrapper:
// a device that lost a rotation race must not wrap its orphan key.
export async function assertLocalKeyMatchesServer(
	token: string,
	scope: string = accountScope(),
): Promise<void> {
	const key = await getMyKeyPair(scope);
	if (key === null) throw new LocalLockRequiredError();
	const version = await getMyKeyVersion(scope);
	await assertServerKeyMatchesLocal(token, key, version, scope);
}

async function persistServerBackupData(
	data: BackupData,
	scope: string = accountScope(),
): Promise<void> {
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	if (data.keyVersion < (await getMyKeyVersion(scope))) {
		throw new StaleKeyStateError();
	}
	// Restoring under a closed lock would leave plaintext keys next to the
	// old wrapper. An unlocked session may restore, but the old wrapper no
	// longer matches the restored key and must be dropped.
	if (await hasLocalLock(scope)) {
		if (!isLocalLockUnlocked(scope)) throw new LocalLockEnabledError();
		await Promise.all([
			metaRepo.setNoNotifyFor(scope, LOCAL_LOCK_META, null),
			metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null),
		]);
	}
	const keyHistory = (data.keyHistory ?? []).slice(-MAX_KEY_HISTORY_LENGTH);
	const identityHistory = (data.identityHistory ?? []).slice(
		-MAX_IDENTITY_HISTORY_LENGTH,
	);
	const identityChain = (data.identityChain ?? []).slice(
		-MAX_IDENTITY_CHAIN_LENGTH,
	);
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, data.keyPair.publicKey);
	await metaRepo.setNoNotifyFor(
		scope,
		PRIVATE_KEY_META,
		data.keyPair.privateKey,
	);
	keyCacheByAccount.set(scope, data.keyPair);
	await storeIdentityKeyPair(data.identityKeyPair, scope);
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, true);
	await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, data.keyVersion);
	await metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, keyHistory);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, identityHistory);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, identityChain);
	keyHistoryByAccount.set(scope, keyHistory);
	identityHistoryByAccount.set(scope, identityHistory);
	identityChainByAccount.set(scope, identityChain);
	notifyKeyMaterialChanged(scope);
}

// A restored key must be the one the server currently advertises. Otherwise
// the backup is stale/orphaned and installing it would make incoming vN
// envelopes unreadable forever.
async function assertRestoredKeyMatchesServer(
	token: string,
	data: BackupData,
	scope: string,
): Promise<boolean> {
	const server = await readServerKeyState(token, scope);
	if (server.publicKey === "") return false;
	if (
		server.version !== data.keyVersion ||
		!samePublicKey(server.publicKey, data.keyPair.publicKey)
	) {
		throw new StaleKeyStateError();
	}
	if (
		server.identityPublicKey !== "" &&
		!samePublicKey(server.identityPublicKey, data.identityKeyPair.publicKey)
	) {
		const known = data.identityHistory ?? [];
		if (!known.some((key) => samePublicKey(key, server.identityPublicKey))) {
			throw new StaleKeyStateError();
		}
	}
	return true;
}

// restoreServerBackupData is the server-backup path: unlike the local PIN
// unlock it must persist the keys, because the caller reloads the page.
export async function restoreServerBackupData(
	data: BackupData,
	token?: string,
): Promise<void> {
	const scope = accountScope();
	const published =
		token === undefined
			? true
			: await assertRestoredKeyMatchesServer(token, data, scope);
	await persistServerBackupData(data, scope);
	if (!published) {
		// The server lost the public key: keep the restored private key but
		// let ensureAccountKeys upload it again.
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, false);
	}
}

export async function verifyBackupPassword(
	token: string,
	password: string,
): Promise<void> {
	const { backup } = await getKeyBackup(token);
	const container = decodeServerBackup(backup);
	const blob = container?.password ?? (container === null ? backup : "");
	if (blob === "")
		throw new E2EBackupError("password backup is not configured");
	await decryptBackupData(password, blob);
}

// restoreKeyPairFromBackup fetches the server backup and recovers the key
// pair under the provided password. Throws E2EBackupError on a wrong
// password and saves the recovered pair locally on success.
export function restoreKeyPairFromBackup(
	token: string,
	password: string,
): Promise<KeyPair> {
	const scope = accountScope();
	return withKeyLock(scope, () =>
		restoreKeyPairFromBackupLocked(scope, token, password),
	);
}

async function restoreKeyPairFromBackupLocked(
	scope: string,
	token: string,
	password: string,
): Promise<KeyPair> {
	const { backup } = await getKeyBackup(token);
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	const container = decodeServerBackup(backup);
	const passwordBlob =
		container?.password ?? (container === null ? backup : "");
	if (passwordBlob === "") {
		throw new E2EBackupError("password backup is not configured");
	}
	const data = await decryptBackupData(password, passwordBlob);
	// The KDF is deliberately slow: a switch during it must not write this
	// account's private key into another account's database.
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	const published = await assertRestoredKeyMatchesServer(token, data, scope);
	await persistServerBackupData(data, scope);
	if (!published) {
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, false);
	}
	return data.keyPair;
}

// clearServerKeyBackup deletes the tracked user's backup blob (revocation
// or when the user starts fresh with a newly generated key pair). The
// version guards against a stale device deleting the current key's backup.
export async function clearServerKeyBackup(
	token: string,
	version?: number,
): Promise<void> {
	try {
		await deleteKeyBackup(token, version ?? (await getMyKeyVersion()));
	} catch (err) {
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		if (!message.includes("404") && !message.includes("not found")) throw err;
	}
}

// serverBackupState is the internal name kept for older callers.
const serverBackupState = getServerBackupState;

export async function hasServerKeyBackup(token: string): Promise<boolean> {
	const state = await serverBackupState(token);
	return state !== "none" && state !== "unknown";
}

// discardRecoveryAndGenerate is chosen when the user declines to recover
// a server backup. The stale backup (which holds an older private key) is
// removed and a brand-new key pair is generated in its place.
export async function discardRecoveryAndGenerate(
	token: string,
	options?: {
		resetLocalLock?: boolean;
		allowIdentityRollback?: boolean;
	},
): Promise<KeyPair> {
	const scope = accountScope();
	// No outer withKeyLock here: this path calls clearLocalKeys and
	// ensureAccountKeys, which take the same non-reentrant Web Lock.
	// Clearing the account also removes the PIN/passkey wrappers. That must be
	// an explicit action, not a side effect of declining recovery.
	if ((await hasLocalLock(scope)) && options?.resetLocalLock !== true) {
		throw new LocalLockEnabledError();
	}
	// Keep the existing identity when it is still on this device: contacts
	// pinned it and a fresh unsigned identity would make every new message
	// unreadable for them.
	const previousIdentity = await getIdentityKeyPair(scope);
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	// The server keeps its old public key (now unusable). The replacement
	// must be published above that version: a version-1 key would be
	// rejected as a rollback and the server would keep handing out the old
	// key forever.
	let nextVersion = 1;
	let serverIdentity = "";
	try {
		const server = await readServerKeyState(token, scope);
		if (server.publicKey !== "") nextVersion = server.version + 1;
		serverIdentity = server.identityPublicKey;
	} catch (err) {
		const message = err instanceof Error ? err.message.toLowerCase() : "";
		if (!message.includes("404") && !message.includes("not found")) {
			throw new KeyBackupCheckFailedError();
		}
	}
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	if (options?.allowIdentityRollback !== true) {
		if (previousIdentity === null && serverIdentity !== "") {
			// Without the old identity there is no signed chain; a fresh
			// identity would make every contact reject future messages.
			throw new StaleKeyStateError();
		}
		if (
			previousIdentity !== null &&
			serverIdentity !== "" &&
			!samePublicKey(previousIdentity.publicKey, serverIdentity)
		) {
			// This device missed a signing rotation. Re-publishing its older
			// identity with a higher version would be an identity rollback;
			// the user must recover the current key instead.
			throw new StaleKeyStateError();
		}
	}
	// Start over means a full local reset: keeping an old local key would
	// make ensureAccountKeys return it unchanged after the backup and
	// identity were already destroyed. Lock wrappers are reset too, because
	// they wrap the discarded key.
	await clearLocalKeys(scope);
	if (previousIdentity !== null) {
		await storeIdentityKeyPair(previousIdentity, scope);
	}
	await clearServerKeyBackup(token, Math.max(1, nextVersion - 1));
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, []);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, []);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, []);
	keyHistoryByAccount.set(scope, []);
	identityHistoryByAccount.set(scope, []);
	identityChainByAccount.set(scope, []);
	forcedVersionByAccount.set(scope, nextVersion);
	if (accountScope() !== scope) {
		forcedVersionByAccount.delete(scope);
		throw new Error(ACCOUNT_CHANGED);
	}
	confirmNewKey();
	try {
		const fresh = await ensureAccountKeys(token);
		if (
			(await getMyKeyVersion(scope)) !== nextVersion ||
			(await metaRepo.getFor(scope, PUBLIC_KEY_UPLOADED_META)) !== true
		) {
			throw new KeyPublishError();
		}
		return fresh;
	} finally {
		forcedVersionByAccount.delete(scope);
	}
}

// getMyKeyPair returns the account's E2E key pair from the local cache
// (per-account IndexedDB). Private keys never leave the device.
// Caches the key pair for the session to avoid repeated IDB reads.
export async function getMyKeyPair(
	scope: string = accountScope(),
): Promise<KeyPair | null> {
	const cached = keyCacheByAccount.get(scope);
	if (cached !== undefined) return cached;

	const [publicKey, privateKey] = await Promise.all([
		metaRepo.getFor(scope, PUBLIC_KEY_META),
		metaRepo.getFor(scope, PRIVATE_KEY_META),
	]);

	if (typeof publicKey !== "string" || typeof privateKey !== "string") {
		return null;
	}

	const kp = { publicKey, privateKey };
	keyCacheByAccount.set(scope, kp);
	return kp;
}

export async function getKeyHistory(
	scope: string = accountScope(),
): Promise<KeyHistoryEntry[]> {
	const cached = keyHistoryByAccount.get(scope);
	if (cached !== undefined) return cached;
	const raw = await metaRepo.getFor(scope, KEY_HISTORY_META);
	const history = Array.isArray(raw)
		? raw.filter(
				(entry): entry is KeyHistoryEntry =>
					typeof entry === "object" &&
					entry !== null &&
					typeof (entry as KeyHistoryEntry).version === "number" &&
					typeof (entry as KeyHistoryEntry).keyPair?.publicKey === "string" &&
					typeof (entry as KeyHistoryEntry).keyPair?.privateKey === "string",
			)
		: [];
	keyHistoryByAccount.set(scope, history);
	return history;
}

export async function getIdentityHistory(
	scope: string = accountScope(),
): Promise<string[]> {
	const cached = identityHistoryByAccount.get(scope);
	if (cached !== undefined) return cached;
	const raw = await metaRepo.getFor(scope, IDENTITY_HISTORY_META);
	const history = Array.isArray(raw)
		? raw.filter((value): value is string => typeof value === "string")
		: [];
	identityHistoryByAccount.set(scope, history);
	return history;
}

export async function getIdentityChain(
	scope: string = accountScope(),
): Promise<IdentityRotation[]> {
	const cached = identityChainByAccount.get(scope);
	if (cached !== undefined) return cached;
	const raw = await metaRepo.getFor(scope, IDENTITY_CHAIN_META);
	const chain = Array.isArray(raw)
		? raw.filter(
				(value): value is IdentityRotation =>
					typeof value === "object" &&
					value !== null &&
					typeof (value as IdentityRotation).from === "string" &&
					typeof (value as IdentityRotation).to === "string" &&
					typeof (value as IdentityRotation).signature === "string",
			)
		: [];
	identityChainByAccount.set(scope, chain);
	return chain;
}

// persistUnlockedHistory writes the in-memory history back to IndexedDB.
// Call it only when no local lock remains, otherwise the old private keys
// would return to plaintext storage.
export async function persistUnlockedHistory(
	scope: string = accountScope(),
): Promise<void> {
	const [keyHistory, identityHistory, identityChain] = await Promise.all([
		getKeyHistory(scope),
		getIdentityHistory(scope),
		getIdentityChain(scope),
	]);
	await Promise.all([
		metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, keyHistory),
		metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, identityHistory),
		metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, identityChain),
	]);
}

export async function getKeyPairForVersion(
	version: number,
): Promise<KeyPair | null> {
	if (version === (await getMyKeyVersion())) return getMyKeyPair();
	const entry = (await getKeyHistory()).find(
		(item) => item.version === version,
	);
	return entry?.keyPair ?? null;
}

// rotateEncryptionKey appends the current key to history and starts a new
// version. Other devices need the password/passkey backup to fetch it.
export function rotateEncryptionKey(
	token: string,
	password: string,
): Promise<KeyPair> {
	const scope = accountScope();
	return withKeyLock(scope, () =>
		rotateEncryptionKeyLocked(scope, token, password),
	);
}

async function rotateEncryptionKeyLocked(
	scope: string,
	token: string,
	password: string,
): Promise<KeyPair> {
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	if (await hasLocalLock(scope)) {
		throw new LocalLockEnabledError();
	}
	const current = await getMyKeyPair(scope);
	const identity = await getIdentityKeyPair(scope);
	if (current === null || identity === null) {
		throw new LocalLockRequiredError();
	}
	await verifyBackupPassword(token, password);
	const existing = decodeServerBackup((await getKeyBackup(token)).backup);
	if (existing?.passkey !== undefined) {
		throw new PasskeyBackupEnabledError();
	}

	const localVersion = await getMyKeyVersion(scope);
	const server = await assertServerKeyMatchesLocal(
		token,
		current,
		localVersion,
		scope,
	);
	if (
		server.identityPublicKey !== "" &&
		!samePublicKey(server.identityPublicKey, identity.publicKey)
	) {
		const known = await getIdentityHistory(scope);
		if (!known.some((key) => samePublicKey(key, server.identityPublicKey))) {
			throw new StaleKeyStateError();
		}
	}
	const version = localVersion + 1;
	const next = await generateKeyPair();
	const history = [
		...(await getKeyHistory(scope)),
		{ version: localVersion, keyPair: current },
	];
	if (history.length > MAX_KEY_HISTORY_LENGTH) {
		history.splice(0, history.length - MAX_KEY_HISTORY_LENGTH);
	}

	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	// Persist the new key before publishing it: if the upload fails, the key
	// is not lost and the same version/key can be retried later.
	await metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, history);
	keyHistoryByAccount.set(scope, history);
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, next.publicKey);
	await metaRepo.setNoNotifyFor(scope, PRIVATE_KEY_META, next.privateKey);
	await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, version);
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, false);
	keyCacheByAccount.set(scope, next);
	notifyKeyMaterialChanged(scope);

	try {
		await uploadPublicKey(token, next.publicKey, identity.publicKey, version);
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, true);
	} catch (err) {
		throw new KeyPublishError(err);
	}

	// The server only accepts a backup whose version equals the published
	// key version, so a device that missed this rotation cannot overwrite it.
	const blob = await encryptBackupData(password, {
		keyPair: next,
		identityKeyPair: identity,
		keyVersion: version,
		keyHistory: history,
		identityHistory: await getIdentityHistory(scope),
		identityChain: await getIdentityChain(scope),
	});
	try {
		await setKeyBackup(
			token,
			encodeServerBackup({
				v: 4,
				masterKeyVersion: version,
				password: blob,
			}),
			version,
		);
	} catch (err) {
		throw new KeyBackupSaveError(err);
	}
	return next;
}

// rotateSigningKey creates a new identity signed by the previous one. The
// chain lets contacts that pinned the old key verify the transition.
export function rotateSigningKey(
	token: string,
	password: string,
): Promise<IdentityKeyPair> {
	const scope = accountScope();
	return withKeyLock(scope, () =>
		rotateSigningKeyLocked(scope, token, password),
	);
}

async function rotateSigningKeyLocked(
	scope: string,
	token: string,
	password: string,
): Promise<IdentityKeyPair> {
	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	if (await hasLocalLock(scope)) {
		throw new LocalLockEnabledError();
	}
	const keyPair = await getMyKeyPair(scope);
	const identity = await getIdentityKeyPair(scope);
	if (keyPair === null || identity === null) {
		throw new LocalLockRequiredError();
	}
	await verifyBackupPassword(token, password);
	const existing = decodeServerBackup((await getKeyBackup(token)).backup);
	if (existing?.passkey !== undefined) {
		throw new PasskeyBackupEnabledError();
	}
	const localVersion = await getMyKeyVersion(scope);
	const server = await assertServerKeyMatchesLocal(
		token,
		keyPair,
		localVersion,
		scope,
	);
	// Two devices rotating the same identity would create sibling chains;
	// peers pinned to one would reject the other. Treat a server identity
	// that is neither ours nor in our history as a missed rotation.
	if (
		server.identityPublicKey !== "" &&
		!samePublicKey(server.identityPublicKey, identity.publicKey)
	) {
		const identityHistory = await getIdentityHistory(scope);
		if (
			!identityHistory.some((key) =>
				samePublicKey(key, server.identityPublicKey),
			)
		) {
			throw new StaleKeyStateError();
		}
	}
	// Identity rotation also advances the master version, so it is serialized
	// against other devices (and the version can guard the backup write).
	const version = localVersion + 1;
	const next = await generateIdentityKeyPair();
	const chain = [
		...(await getIdentityChain(scope)),
		{
			from: identity.publicKey,
			to: next.publicKey,
			signature: await signSenderBinding(
				identity,
				`identity-rotation:${identity.publicKey}`,
				next.publicKey,
			),
		},
	];
	// Peers need the links from their pinned identity to the current one.
	// Keep the newest links only: an unbounded chain would eventually make
	// every message exceed the server payload limit.
	if (chain.length > MAX_IDENTITY_CHAIN_LENGTH) {
		chain.splice(0, chain.length - MAX_IDENTITY_CHAIN_LENGTH);
	}
	const history = [...(await getIdentityHistory(scope)), identity.publicKey];
	if (history.length > MAX_IDENTITY_HISTORY_LENGTH) {
		history.splice(0, history.length - MAX_IDENTITY_HISTORY_LENGTH);
	}
	const keyHistory = [...(await getKeyHistory(scope))];
	if (!keyHistory.some((entry) => entry.version === localVersion)) {
		keyHistory.push({ version: localVersion, keyPair });
	}
	if (keyHistory.length > MAX_KEY_HISTORY_LENGTH) {
		keyHistory.splice(0, keyHistory.length - MAX_KEY_HISTORY_LENGTH);
	}

	if (accountScope() !== scope) throw new Error(ACCOUNT_CHANGED);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, chain);
	await metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, history);
	await metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, keyHistory);
	await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, version);
	identityChainByAccount.set(scope, chain);
	identityHistoryByAccount.set(scope, history);
	keyHistoryByAccount.set(scope, keyHistory);
	await storeIdentityKeyPair(next, scope);
	notifyKeyMaterialChanged(scope);

	try {
		await uploadPublicKey(token, keyPair.publicKey, next.publicKey, version);
		await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, true);
	} catch (err) {
		throw new KeyPublishError(err);
	}

	const blob = await encryptBackupData(password, {
		keyPair,
		identityKeyPair: next,
		keyVersion: version,
		keyHistory,
		identityHistory: history,
		identityChain: chain,
	});
	try {
		await setKeyBackup(
			token,
			encodeServerBackup({
				v: 4,
				masterKeyVersion: version,
				password: blob,
			}),
			version,
		);
	} catch (err) {
		throw new KeyBackupSaveError(err);
	}
	return next;
}

// getMyKeyVersion returns the local master key version. Older state without
// the marker is version 1.
export async function getMyKeyVersion(
	scope: string = accountScope(),
): Promise<number> {
	const cached = keyVersionCache.get(scope);
	if (cached !== undefined) return cached;
	const value = await metaRepo.getFor(scope, KEY_VERSION_META);
	const version = typeof value === "number" && value >= 1 ? value : 1;
	keyVersionCache.set(scope, version);
	return version;
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
			const existing = await getMyKeyPair(scope);
			if (existing !== null) {
				// The key exists locally. Make sure the server has the
				// public half (retries after a failed upload or a server
				// DB reset).
				if (token !== undefined) {
					await uploadPublicKeyIfNeeded(scope, token);
				}
				return existing;
			}

			if (token === undefined) {
				throw new Error("cannot generate E2E keys without an active session");
			}
			if (await hasLocalLock(scope)) {
				throw new LocalLockRequiredError();
			}

			// No local key pair. Before generating a brand-new pair, check
			// whether the server holds a backup for this account. If it
			// does, ask the user to recover instead of silently creating
			// divergent keys.
			const backupState = await serverBackupState(token, scope);
			if (backupState === "unknown") {
				throw new KeyBackupCheckFailedError();
			}
			if (backupState === "backup" || backupState === "local-stale") {
				// On a fresh device localVersion is 1 while the server backup
				// is already at N>1; that is normal recovery, not a reason to
				// create (and later overwrite) a new key.
				emitRecoveryNeeded(token);
				throw new RecoveryRequiredError();
			}
			// The server may still publish an older key without a backup
			// (a failed upload or a deleted backup). A version-1 replacement
			// would be rejected as a rollback, so start above it.
			if (!forcedVersionByAccount.has(scope)) {
				try {
					const server = await readServerKeyState(token, scope);
					if (server.publicKey !== "") {
						forcedVersionByAccount.set(scope, server.version + 1);
					}
				} catch {
					// Offline: generation below still tries version 1 and the
					// upload will surface a stale-key recovery if needed.
				}
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
				const epoch = lockEpoch(scope);
				// Another tab may have generated the key while this flight
				// was waiting for the lock. Re-read without the stale cache.
				keyCacheByAccount.delete(scope);
				const raced = await getMyKeyPair(scope);
				if (raced !== null) return raced;
				if (accountScope() !== scope) {
					throw new Error(ACCOUNT_CHANGED);
				}
				const generated = await generateKeyPair();
				if (accountScope() !== scope) {
					throw new Error(ACCOUNT_CHANGED);
				}
				// A lock that closed during generation must win over the new
				// plaintext key.
				assertLockEpoch(scope, epoch);
				if ((await hasLocalLock(scope)) && !isLocalLockUnlocked(scope)) {
					throw new LocalLockRequiredError();
				}
				const version = forcedVersionByAccount.get(scope) ?? 1;
				forcedVersionByAccount.delete(scope);
				// Save locally first so decryption works even if the server
				// is unreachable; the upload is retried on later calls.
				await metaRepo.setNoNotifyFor(
					scope,
					PUBLIC_KEY_META,
					generated.publicKey,
				);
				await metaRepo.setNoNotifyFor(
					scope,
					PRIVATE_KEY_META,
					generated.privateKey,
				);
				await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, version);
				await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_UPLOADED_META, false);
				keyCacheByAccount.set(scope, generated);
				notifyKeyMaterialChanged(scope);
				await uploadPublicKeyIfNeeded(scope, token);
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
): Promise<{ publicKey: string; keyVersion: number }> {
	const scope = accountScope();
	const cached = await metaRepo.getFor(scope, pubKeyCacheKey(userId));
	if (isFreshCachedPubKey(cached)) {
		return { publicKey: cached.publicKey, keyVersion: cached.keyVersion };
	}
	const stale =
		typeof cached === "object" &&
		cached !== null &&
		typeof (cached as CachedPubKey).publicKey === "string" &&
		typeof (cached as CachedPubKey).keyVersion === "number"
			? (cached as CachedPubKey)
			: null;

	let publicKey: string;
	let masterKeyVersion: number;
	try {
		({ publicKey, masterKeyVersion } = await getPublicKey(token, userId));
	} catch (err) {
		// Offline/5xx: a slightly stale key is better than dropping the
		// message as "no key". A 4xx means the server answered (404: user has
		// no key, 401: session is invalid) and the stale key may be wrong.
		const status =
			typeof err === "object" && err !== null && "status" in err
				? (err as { status?: unknown }).status
				: undefined;
		const transient = typeof status !== "number" || status >= 500;
		if (stale !== null && transient) {
			return {
				publicKey: stale.publicKey,
				keyVersion: stale.keyVersion,
			};
		}
		throw err;
	}
	const keyVersion = masterKeyVersion >= 1 ? masterKeyVersion : 1;
	await metaRepo.setNoNotifyFor(scope, pubKeyCacheKey(userId), {
		publicKey,
		keyVersion,
		fetchedAt: Date.now(),
	});

	return { publicKey, keyVersion };
}

// hasPinLock reports whether this account's keys are wrapped by a PIN.
export async function hasPinLock(
	scope: string = accountScope(),
): Promise<boolean> {
	const blob = await metaRepo.getFor(scope, LOCAL_LOCK_META);
	return typeof blob === "string" && blob !== "";
}

// Cached lock presence lets synchronous callers (media rendering) avoid an
// IndexedDB read per attachment. hasLocalLock fills it on mount/events.
const localLockConfiguredByScope = new Map<string, boolean>();

export function isLocalLockConfigured(
	scope: string = accountScope(),
): boolean | undefined {
	return localLockConfiguredByScope.get(scope);
}

// hasLocalLock reports whether any local unlock factor protects the keys.
export async function hasLocalLock(
	scope: string = accountScope(),
): Promise<boolean> {
	const passkey = await metaRepo.getFor(scope, PASSKEY_LOCK_META);
	const configured =
		(await hasPinLock(scope)) ||
		(typeof passkey === "string" && passkey !== "");
	localLockConfiguredByScope.set(scope, configured);
	return configured;
}

// setUnlockedMasterKeys installs keys decrypted from the local lock. They
// stay in memory only; nothing is written back to IndexedDB.
export async function setUnlockedMasterKeys(
	data: BackupData,
	scope: string = accountScope(),
): Promise<void> {
	if (data.keyVersion < (await getMyKeyVersion(scope))) {
		throw new StaleKeyStateError();
	}
	keyCacheByAccount.set(scope, data.keyPair);
	identityCacheByAccount.set(scope, data.identityKeyPair);
	keyHistoryByAccount.set(scope, data.keyHistory ?? []);
	identityHistoryByAccount.set(scope, data.identityHistory ?? []);
	identityChainByAccount.set(scope, data.identityChain ?? []);
	await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, data.keyVersion);
	keyVersionCache.set(scope, data.keyVersion);
	// History is secret: it stays in memory while the lock is closed and must
	// not remain in plaintext IndexedDB.
	await Promise.all([
		metaRepo.setNoNotifyFor(scope, KEY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_HISTORY_META, null),
		metaRepo.setNoNotifyFor(scope, IDENTITY_CHAIN_META, null),
	]);
}

// isLocalLockUnlocked reports whether the keys are available in this session.
export function isLocalLockUnlocked(scope: string = accountScope()): boolean {
	return keyCacheByAccount.has(scope) && identityCacheByAccount.has(scope);
}

// lockLocalKeys forgets the in-memory master key without touching the lock.
export function lockLocalKeys(scope: string = accountScope()): void {
	lockEpochByAccount.set(scope, lockEpoch(scope) + 1);
	keyCacheByAccount.delete(scope);
	identityCacheByAccount.delete(scope);
	keyHistoryByAccount.delete(scope);
	identityHistoryByAccount.delete(scope);
	identityChainByAccount.delete(scope);
	identityInFlightByAccount.delete(scope);
	inFlightByAccount.delete(scope);
	void clearDecryptedFileCache(scope === "" ? null : scope);
	notifyLocalKeyMaterialChanged();
}

export function requestRecoveryAfterForgotPin(token: string): void {
	emitRecoveryNeeded(token);
}

// clearLocalKeys drops the cached key pair and removes both halves from the
// active account's IndexedDB. Call it on logout / account removal so the next
// user of the device cannot recover the previous account's private key from
// the local database.
export function clearLocalKeys(scope: string = accountScope()): Promise<void> {
	return withKeyLock(scope, () => clearLocalKeysLocked(scope));
}

async function clearLocalKeysLocked(scope: string): Promise<void> {
	lockEpochByAccount.set(scope, lockEpoch(scope) + 1);
	keyCacheByAccount.delete(scope);
	keyVersionCache.delete(scope);
	keyHistoryByAccount.delete(scope);
	identityHistoryByAccount.delete(scope);
	identityChainByAccount.delete(scope);
	identityInFlightByAccount.delete(scope);
	inFlightByAccount.delete(scope);
	inFlightIdByAccount.delete(scope);
	confirmedNewKey.delete(scope);
	const db = await getDBFor(scope);
	await Promise.all([
		db.delete("meta", PUBLIC_KEY_META),
		db.delete("meta", PRIVATE_KEY_META),
		db.delete("meta", PUBLIC_KEY_UPLOADED_META),
		db.delete("meta", IDENTITY_PUBLIC_KEY_META),
		db.delete("meta", IDENTITY_PRIVATE_KEY_META),
		db.delete("meta", KEY_VERSION_META),
		db.delete("meta", LOCAL_LOCK_META),
		db.delete("meta", PASSKEY_LOCK_META),
		db.delete("meta", KEY_HISTORY_META),
		db.delete("meta", IDENTITY_HISTORY_META),
		db.delete("meta", IDENTITY_CHAIN_META),
	]).catch(() => {});
	identityCacheByAccount.delete(scope);
}

// getRecipientDeviceKeys returns the master key of every member. v3 keys a
// message to the account, not to an individual browser session.
export interface RecipientDeviceKey {
	keyId: string;
	publicKey: string;
	keyVersion: number;
}

export async function getRecipientDeviceKeys(
	token: string,
	userIds: string[],
): Promise<Map<string, RecipientDeviceKey[]>> {
	const out = new Map<string, RecipientDeviceKey[]>();
	await Promise.all(
		userIds.map(async (userId) => {
			try {
				const { publicKey, keyVersion } = await getRecipientPublicKey(
					token,
					userId,
				);
				if (publicKey !== "") {
					out.set(userId, [{ keyId: userId, publicKey, keyVersion }]);
				}
			} catch {
				// The caller reports the missing key.
			}
		}),
	);
	return out;
}
