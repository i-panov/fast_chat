import { getPublicKey, uploadPublicKey } from "../api.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";

const PRIVATE_KEY_META = "e2ee.privateKey";
const PUBLIC_KEY_META = "e2ee.publicKey";

function pubKeyCacheKey(userId: string): string {
	return `e2ee.pubkey.${userId}`;
}

// getMyKeyPair returns the account's E2E key pair from the local cache
// (per-account IndexedDB). Private keys never leave the device.
export async function getMyKeyPair(): Promise<KeyPair | null> {
	const [publicKey, privateKey] = await Promise.all([
		metaRepo.get(PUBLIC_KEY_META),
		metaRepo.get(PRIVATE_KEY_META),
	]);

	if (typeof publicKey !== "string" || typeof privateKey !== "string") {
		return null;
	}

	return { publicKey, privateKey };
}

// ensureAccountKeys generates a key pair on first use, uploads the
// public half to the server and persists both halves locally.
export async function ensureAccountKeys(
	token: string | undefined,
): Promise<KeyPair> {
	const existing = await getMyKeyPair();
	if (existing !== null) return existing;

	if (token === undefined) {
		throw new Error("cannot generate E2E keys without an active session");
	}

	const kp = await generateKeyPair();
	await uploadPublicKey(token, kp.publicKey);
	await metaRepo.set(PUBLIC_KEY_META, kp.publicKey);
	await metaRepo.set(PRIVATE_KEY_META, kp.privateKey);

	return kp;
}

// getRecipientPublicKey returns another user's public key, fetching and
// caching it from the server (transparently proxying federated users).
export async function getRecipientPublicKey(
	token: string,
	userId: string,
): Promise<string> {
	const cached = await metaRepo.get(pubKeyCacheKey(userId));
	if (typeof cached === "string" && cached !== "") return cached;

	const { publicKey } = await getPublicKey(token, userId);
	await metaRepo.set(pubKeyCacheKey(userId), publicKey);

	return publicKey;
}

export async function getRecipientPublicKeys(
	token: string,
	userIds: string[],
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const id of userIds) {
		out.set(id, await getRecipientPublicKey(token, id));
	}
	return out;
}
