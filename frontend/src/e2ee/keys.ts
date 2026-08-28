import { getPublicKey, uploadPublicKey } from "../api.ts";
import { getActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";

const PRIVATE_KEY_META = "e2ee.privateKey";
const PUBLIC_KEY_META = "e2ee.publicKey";
const PUBLIC_KEY_UPLOADED_META = "e2ee.publicKeyUploaded";

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
// Single-flight: concurrent calls share the same promise.
export async function ensureAccountKeys(
	token: string | undefined,
): Promise<KeyPair> {
	const existing = await getMyKeyPair();
	if (existing !== null) {
		// The key exists locally. Make sure the server has the public
		// half (retries after a failed upload or a server DB reset).
		if (token !== undefined) {
			await uploadPublicKeyIfNeeded(token, existing.publicKey);
		}
		return existing;
	}

	if (token === undefined) {
		throw new Error("cannot generate E2E keys without an active session");
	}

	const scope = accountScope();
	const inFlight = inFlightByAccount.get(scope);
	if (inFlight !== undefined) {
		return inFlight;
	}

	const run = (async () => {
		try {
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
