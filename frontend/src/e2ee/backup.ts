import sodium from "libsodium-wrappers";
import {
	decodeBase64,
	ensureSodium,
	type IdentityKeyPair,
	type KeyPair,
} from "./crypto.ts";

// libsodium-wrappers is compiled without the password-hashing (Argon2id)
// primitives, so the passphrase KDF uses the browser's native WebCrypto
// PBKDF2 instead. The derived key still feeds libsodium's XChaCha20-Poly1305
// AEAD, so encryption/decryption stay on the existing crypto stack.
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 recommendation for PBKDF2-SHA256
// Blobs arrive from the server, so the iteration count is attacker-controlled.
// Values below the floor are treated as absent; a value above the ceiling is
// rejected instead of parking the tab in deriveBits for minutes/hours.
const MIN_PBKDF2_ITERATIONS = 100_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const KEY_BYTES = 32; // XChaCha20-Poly1305 key length

// Version tag in the serialized payload. Bumped whenever the blob shape
// changes so we can reject old blobs and migrate rather than mis-parsing.
const BLOB_VERSION = 3;
const MALFORMED_BACKUP_MSG = "malformed backup blob";

interface PlainBackup {
	publicKey: string;
	privateKey: string;
	identityPublicKey: string;
	identityPrivateKey: string;
	keyVersion: number;
	keyHistory?: Array<{
		version: number;
		publicKey: string;
		privateKey: string;
	}>;
	identityHistory?: string[];
	identityChain?: Array<{ from: string; to: string; signature: string }>;
}

export interface KeyHistoryEntry {
	version: number;
	keyPair: KeyPair;
}

export interface IdentityRotation {
	from: string;
	to: string;
	signature: string;
}

export interface BackupData {
	keyPair: KeyPair;
	identityKeyPair: IdentityKeyPair;
	keyVersion: number;
	keyHistory?: KeyHistoryEntry[];
	identityHistory?: string[];
	identityChain?: IdentityRotation[];
}

interface BlobPayload {
	v: number; // format version
	iterations?: number; // PBKDF2 rounds; absent in old blobs
	salt: string; // base64 PBKDF2 salt
	nonce: string; // base64 XChaCha20 nonce
	ct: string; // base64 ciphertext of PlainBackup JSON
}

// resolveIterations bounds the KDF cost read from an untrusted blob.
function resolveIterations(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return PBKDF2_ITERATIONS;
	}
	const iterations = Math.floor(value);
	if (iterations < MIN_PBKDF2_ITERATIONS) return PBKDF2_ITERATIONS;
	if (iterations > MAX_PBKDF2_ITERATIONS) {
		throw new E2EBackupError("unsupported backup format");
	}
	return iterations;
}

function toBase64(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin);
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

// deriveKey derives an AEAD key from the passphrase via PBKDF2-SHA256.
// The salt is embedded in the blob so the key can be re-derived on restore.
async function deriveKey(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array> {
	const enc = new TextEncoder();
	const material = await crypto.subtle.importKey(
		"raw",
		enc.encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations },
		material,
		KEY_BYTES * 8,
	);
	return new Uint8Array(bits);
}

// encryptBackup produces an opaque, self-describing blob that the server
// stores verbatim. Without the password the private key cannot be recovered.
// An empty password is rejected: it would produce a valid-looking blob on a
// trivially guessable key. Callers should enforce a stronger minimum (the UI
// validates length); this is only the last-resort guard.
export async function encryptBackupData(
	password: string,
	data: BackupData,
): Promise<string> {
	if (password === "") {
		throw new E2EBackupError("backup password must not be empty");
	}
	await ensureSodium();

	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const key = await deriveKey(password, salt);
	const nonce = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
	);

	const plain: PlainBackup = {
		publicKey: data.keyPair.publicKey,
		privateKey: data.keyPair.privateKey,
		identityPublicKey: data.identityKeyPair.publicKey,
		identityPrivateKey: data.identityKeyPair.privateKey,
		keyVersion: Math.max(1, data.keyVersion),
		keyHistory: data.keyHistory?.map((entry) => ({
			version: entry.version,
			publicKey: entry.keyPair.publicKey,
			privateKey: entry.keyPair.privateKey,
		})),
		identityHistory: data.identityHistory,
		identityChain: data.identityChain,
	};
	const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		sodium.from_string(JSON.stringify(plain)),
		null,
		null,
		nonce,
		key,
	);

	const payload: BlobPayload = {
		v: BLOB_VERSION,
		iterations: PBKDF2_ITERATIONS,
		salt: toBase64(salt),
		nonce: sodium.to_base64(nonce),
		ct: sodium.to_base64(ct),
	};

	return toBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

// decryptBackup recovers the key pair from a blob. Throws E2EBackupError
// if the password is wrong or the blob is malformed.
export class E2EBackupError extends Error {}

export async function decryptBackupData(
	password: string,
	blob: string,
): Promise<BackupData> {
	if (password === "") {
		throw new E2EBackupError("backup password must not be empty");
	}
	await ensureSodium();

	let payload: BlobPayload;
	try {
		payload = JSON.parse(
			new TextDecoder().decode(fromBase64(blob)),
		) as BlobPayload;
	} catch {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	if (
		typeof payload?.salt !== "string" ||
		typeof payload?.nonce !== "string" ||
		typeof payload?.ct !== "string"
	) {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	// Reject blobs written by an older (or newer) format rather than
	// silently mis-parsing a changed payload shape.
	if (payload.v !== BLOB_VERSION) {
		throw new E2EBackupError("unsupported backup format");
	}

	let salt: Uint8Array<ArrayBuffer>;
	let nonce: Uint8Array;
	let ciphertext: Uint8Array;
	try {
		salt = fromBase64(payload.salt);
		nonce = decodeBase64(payload.nonce);
		ciphertext = decodeBase64(payload.ct);
	} catch {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	if (
		salt.length !== SALT_BYTES ||
		nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
	) {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	const iterations = resolveIterations(payload.iterations);
	const key = await deriveKey(password, salt, iterations);

	let plain: Uint8Array;
	try {
		plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
			null,
			ciphertext,
			null,
			nonce,
			key,
		);
	} catch {
		throw new E2EBackupError("wrong password");
	}

	let parsed: PlainBackup;
	try {
		parsed = JSON.parse(sodium.to_string(plain)) as PlainBackup;
	} catch {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	if (
		typeof parsed?.publicKey !== "string" ||
		typeof parsed?.privateKey !== "string" ||
		typeof parsed.identityPublicKey !== "string" ||
		typeof parsed.identityPrivateKey !== "string" ||
		typeof parsed.keyVersion !== "number" ||
		parsed.keyVersion < 1
	) {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	return {
		keyPair: { publicKey: parsed.publicKey, privateKey: parsed.privateKey },
		identityKeyPair: {
			publicKey: parsed.identityPublicKey,
			privateKey: parsed.identityPrivateKey,
		},
		keyVersion: parsed.keyVersion,
		keyHistory: Array.isArray(parsed.keyHistory)
			? parsed.keyHistory
					.filter(
						(
							entry,
						): entry is {
							version: number;
							publicKey: string;
							privateKey: string;
						} =>
							typeof entry?.version === "number" &&
							typeof entry.publicKey === "string" &&
							typeof entry.privateKey === "string",
					)
					.map((entry) => ({
						version: entry.version,
						keyPair: {
							publicKey: entry.publicKey,
							privateKey: entry.privateKey,
						},
					}))
			: undefined,
		identityHistory: Array.isArray(parsed.identityHistory)
			? parsed.identityHistory.filter((key) => typeof key === "string")
			: undefined,
		identityChain: Array.isArray(parsed.identityChain)
			? parsed.identityChain.filter(
					(item): item is IdentityRotation =>
						typeof item?.from === "string" &&
						typeof item.to === "string" &&
						typeof item.signature === "string",
				)
			: undefined,
	};
}

// ServerBackupContainer keeps the same master-key payload wrapped by several
// independent factors. The server stores it verbatim and cannot open either
// wrapper.
export interface PasskeyBackupWrapper {
	credentialId: string;
	salt: string;
	blob: string;
}

export interface ServerBackupContainer {
	v: 4;
	// Plaintext master-key version. The server cannot verify the encrypted
	// payload, but the client uses it to tell a current backup from a stale
	// one after a rotation on another device.
	masterKeyVersion?: number;
	password?: string;
	passkey?: PasskeyBackupWrapper;
}

export function encodeServerBackup(container: ServerBackupContainer): string {
	return btoa(JSON.stringify(container));
}

export function decodeServerBackup(blob: string): ServerBackupContainer | null {
	try {
		const parsed = JSON.parse(atob(blob)) as Partial<ServerBackupContainer>;
		if (parsed.v !== 4) return null;
		return {
			v: 4,
			masterKeyVersion:
				typeof parsed.masterKeyVersion === "number" &&
				parsed.masterKeyVersion >= 1
					? parsed.masterKeyVersion
					: undefined,
			password:
				typeof parsed.password === "string" ? parsed.password : undefined,
			passkey:
				typeof parsed.passkey === "object" &&
				parsed.passkey !== null &&
				typeof parsed.passkey.credentialId === "string" &&
				typeof parsed.passkey.salt === "string" &&
				typeof parsed.passkey.blob === "string"
					? parsed.passkey
					: undefined,
		};
	} catch {
		return null;
	}
}
