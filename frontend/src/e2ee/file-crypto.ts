import sodium from "libsodium-wrappers";
import { ensureSodium } from "./crypto.ts";

// computePlaintextHash returns the SHA-256 hex digest of the file content.
// SHA-256 matches the server's own hash computation for unencrypted files,
// so the same hash can be used for dedup across both encrypted and plaintext
// uploads. The hash is sent to the server alongside the encrypted blob so the
// server can deduplicate files by their plaintext content without ever seeing
// the plaintext itself. A content hash is not considered confidential — it is a
// fingerprint that reveals nothing about the content without the content itself.
export async function computePlaintextHash(blob: Blob): Promise<string> {
	const data = new Uint8Array(await blob.arrayBuffer());
	const digest = await crypto.subtle.digest("SHA-256", data);

	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// FileKey wraps the per-file encryption key together with the nonce used
// for the streaming cipher. It is sealed to each recipient's public key and
// stored inside the message's encrypted content.
export interface FileKey {
	nonce: string; // base64, 24 bytes for XChaCha20
	key: string; // base64, 32 bytes
}

const FILE_KEY_BYTES = 32;
const FILE_NONCE_BYTES = 24; // crypto_aead_xchacha20poly1305_ietf_NPUBBYTES

// hashBytes returns the SHA-256 hex digest of already-read bytes. It shares
// computePlaintextHash's digest so hashes stay comparable, but avoids
// re-reading the file when the caller already holds its content.
export async function hashBytes(
	data: Uint8Array<ArrayBuffer>,
): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);

	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// encryptBytes encrypts already-read bytes with the file key. Prefer it over
// encryptFileStream when the plaintext was already read (e.g. for hashing)
// so large files are read from disk exactly once.
export async function encryptBytes(
	data: Uint8Array,
	fileKey: FileKey,
): Promise<Uint8Array> {
	await ensureSodium();
	const key = sodium.from_base64(fileKey.key);
	const nonce = sodium.from_base64(fileKey.nonce);

	return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		data,
		null, // additional data
		null, // secret nonce
		nonce,
		key,
	);
}

// generateFileKey creates a fresh random key for a file.
export async function generateFileKey(): Promise<FileKey> {
	await ensureSodium();
	return {
		nonce: sodium.to_base64(sodium.randombytes_buf(FILE_NONCE_BYTES)),
		key: sodium.to_base64(sodium.randombytes_buf(FILE_KEY_BYTES)),
	};
}

// encryptFileStream encrypts a Blob using XChaCha20-Poly1305 and returns the
// full ciphertext. Note: the entire file is loaded into memory — for very
// large files (multi-hundred MiB) this may cause memory pressure. Consider
// chunked streaming encryption if this becomes a bottleneck.
export async function encryptFileStream(
	blob: Blob,
	fileKey: FileKey,
): Promise<Uint8Array> {
	await ensureSodium();
	const key = sodium.from_base64(fileKey.key);
	const nonce = sodium.from_base64(fileKey.nonce);
	const data = new Uint8Array(await blob.arrayBuffer());

	return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		data,
		null, // additional data
		null, // secret nonce
		nonce,
		key,
	);
}

// decryptFileStream reverses encryptFileStream.
export async function decryptFileStream(
	ciphertext: Uint8Array,
	fileKey: FileKey,
): Promise<Uint8Array> {
	await ensureSodium();
	const key = sodium.from_base64(fileKey.key);
	const nonce = sodium.from_base64(fileKey.nonce);

	return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		ciphertext,
		null,
		nonce,
		key,
	);
}
