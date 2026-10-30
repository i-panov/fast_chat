import sodium from "libsodium-wrappers";
import { ensureSodium, type KeyPair } from "./crypto.ts";

// libsodium-wrappers is compiled without the password-hashing (Argon2id)
// primitives, so the passphrase KDF uses the browser's native WebCrypto
// PBKDF2 instead. The derived key still feeds libsodium's XChaCha20-Poly1305
// AEAD, so encryption/decryption stay on the existing crypto stack.
const PBKDF2_ITERATIONS = 310_000; // OWASP 2023 recommendation for PBKDF2-SHA256
const PBKDF2_HASH = "SHA-256";
const SALT_BYTES = 16;
const KEY_BYTES = 32; // XChaCha20-Poly1305 key length

// Version tag in the serialized payload. Bumped whenever the blob shape
// changes so we can reject old blobs and migrate rather than mis-parsing.
const BLOB_VERSION = 1;
const MALFORMED_BACKUP_MSG = "malformed backup blob";

interface PlainBackup {
	publicKey: string;
	privateKey: string;
}

interface BlobPayload {
	v: typeof BLOB_VERSION; // format version
	salt: string; // base64 PBKDF2 salt
	nonce: string; // base64 XChaCha20 nonce
	ct: string; // base64 ciphertext of PlainBackup JSON
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
		{ name: "PBKDF2", hash: PBKDF2_HASH, salt, iterations: PBKDF2_ITERATIONS },
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
export async function encryptBackup(
	password: string,
	kp: KeyPair,
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
		publicKey: kp.publicKey,
		privateKey: kp.privateKey,
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
		salt: toBase64(salt),
		nonce: sodium.to_base64(nonce),
		ct: sodium.to_base64(ct),
	};

	return toBase64(new TextEncoder().encode(JSON.stringify(payload)));
}

// decryptBackup recovers the key pair from a blob. Throws E2EBackupError
// if the password is wrong or the blob is malformed.
export class E2EBackupError extends Error {}

export async function decryptBackup(
	password: string,
	blob: string,
): Promise<KeyPair> {
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
		nonce = sodium.from_base64(payload.nonce);
		ciphertext = sodium.from_base64(payload.ct);
	} catch {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	if (
		salt.length !== SALT_BYTES ||
		nonce.length !== sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
	) {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	const key = await deriveKey(password, salt);

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
		typeof parsed?.privateKey !== "string"
	) {
		throw new E2EBackupError(MALFORMED_BACKUP_MSG);
	}

	return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
}
