import {
	deleteKeyBackup,
	getKeyBackup,
	getPublicKey,
	setKeyBackup,
	uploadPublicKey,
} from "../api.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { decryptBackup, encryptBackup } from "./backup.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";

const PRIVATE_KEY_META = "e2ee.privateKey";
const PUBLIC_KEY_META = "e2ee.publicKey";
const PUBLIC_KEY_UPLOADED_META = "e2ee.publicKeyUploaded";

// Throw when the account has no local key pair but a backup exists on the
// server, so the client asks the user to recover instead of silently
// generating a divergent key pair (which would orphan their old messages).
export class RecoveryRequiredError extends Error {
	constructor() {
		super("account keys are recoverable from a server backup");
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

// Per-account in-memory caches. The active account key scopes them so
// switching accounts (a pure SPA transition, no reload) never leaks one
// account's key pair into another's requests. IndexedDB is already
// per-account; these mirrors keep repeated reads off the DB.
const keyCacheByAccount = new Map<string, KeyPair>();
const inFlightByAccount = new Map<string, Promise<KeyPair>>();

function accountScope(): string {
	return getActiveAccountKey() ?? "";
}

// --- Server key backup (recovery) ---------------------------------------

export type BackupState = "none" | "backup" | "unknown";

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

// uploadKeyBackup encrypts the given key pair under the password and
// stores the blob on the server for cross-device recovery.
export async function uploadKeyBackup(
	token: string,
	password: string,
	kp: KeyPair,
): Promise<void> {
	const blob = await encryptBackup(password, kp);
	await setKeyBackup(token, blob);
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
export async function clearServerKeyBackup(token: string): Promise<void> {
	await deleteKeyBackup(token);
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

	const run = (async () => {
		try {
			const existing = await getMyKeyPair();
			if (existing !== null) {
				// The key exists locally. Make sure the server has the
				// public half (retries after a failed upload or a server
				// DB reset).
				if (token !== undefined) {
					await uploadPublicKeyIfNeeded(token, existing.publicKey);
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
			if (backupState !== "none") {
				if (backupState === "backup") {
					emitRecoveryNeeded(token);
				}
				throw new RecoveryRequiredError();
			}

			const kp = await generateKeyPair();
			// Save locally first so decryption works even if the server
			// is unreachable; the upload is retried on later calls.
			await metaRepo.setNoNotify(PUBLIC_KEY_META, kp.publicKey);
			await metaRepo.setNoNotify(PRIVATE_KEY_META, kp.privateKey);
			await metaRepo.setNoNotify(PUBLIC_KEY_UPLOADED_META, false);
			keyCacheByAccount.set(scope, kp);
			await uploadPublicKeyIfNeeded(token, kp.publicKey);
			return kp;
		} finally {
			inFlightByAccount.delete(scope);
		}
	})();

	inFlightByAccount.set(scope, run);
	return run;
}

// getRecipientPublicKey returns another user's public key, fetching and
// caching it from the server (transparently proxying federated users).
// The cache expires after a few minutes so key changes are picked up.
export async function getRecipientPublicKey(
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

export async function getRecipientPublicKeys(
	token: string,
	userIds: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	// Parallel fetch with limit of 4 to avoid overwhelming the server
	const chunkSize = 4;
	for (let i = 0; i < userIds.length; i += chunkSize) {
		const chunk = userIds.slice(i, i + chunkSize);
		const keys = await Promise.all(
			chunk.map((id) => getRecipientPublicKey(token, id)),
		);
		for (let j = 0; j < chunk.length; j++) {
			out.set(chunk[j], keys[j]);
		}
	}
	return out;
}
