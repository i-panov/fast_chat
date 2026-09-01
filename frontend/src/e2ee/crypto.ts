import sodium from "libsodium-wrappers";
import type { FileKey } from "./file-crypto.ts";

export interface Envelope {
	keyId: string;
	box: string; // base64 sealed message key
}

export interface EncryptedPayload {
	v: 1;
	nonce: string; // base64
	envelopes: Envelope[];
}

export interface KeyPair {
	publicKey: string; // base64 X25519
	privateKey: string; // base64 X25519
}

let readyPromise: Promise<void> | null = null;

export function ensureSodium(): Promise<void> {
	if (readyPromise === null) {
		readyPromise = sodium.ready;
	}
	return readyPromise;
}

export async function generateKeyPair(): Promise<KeyPair> {
	await ensureSodium();
	const kp = sodium.crypto_box_keypair();
	return {
		publicKey: sodium.to_base64(kp.publicKey),
		privateKey: sodium.to_base64(kp.privateKey),
	};
}

// Seal the message key to every recipient's public key. Only the holder
// of the matching private key can open its envelope.
export async function sealMessageKey(
	msgKey: Uint8Array,
	recipients: Array<{ keyId: string; publicKey: string }>,
): Promise<Envelope[]> {
	await ensureSodium();

	return recipients.map((r) => ({
		keyId: r.keyId,
		box: sodium.to_base64(
			sodium.crypto_box_seal(msgKey, sodium.from_base64(r.publicKey)),
		),
	}));
}

export async function openMessageKey(
	envelope: Envelope,
	publicKey: string,
	privateKey: string,
): Promise<Uint8Array> {
	await ensureSodium();
	return sodium.crypto_box_seal_open(
		sodium.from_base64(envelope.box),
		sodium.from_base64(publicKey),
		sodium.from_base64(privateKey),
	);
}

export interface EncryptedText {
	nonce: string;
	ciphertext: string;
}

// MessageContent holds every sensitive field of a message. The whole struct
// is serialised to JSON and encrypted as a single blob, so the server never
// sees plaintext text, location, file metadata, or reply previews.
export interface MessageContent {
	text: string;
	location?: { lat: number; lng: number };
	replyToText?: string;
	fileKeys?: FileKey[];
}

// EncryptedContent is what gets stored in the message record and sent over
// the wire. The ciphertext is the JSON-serialised MessageContent.
export interface EncryptedContent {
	v: 1;
	nonce: string;
	ciphertext: string;
}

export async function encryptContent(
	content: MessageContent,
	msgKey: Uint8Array,
): Promise<EncryptedContent> {
	await ensureSodium();
	const nonce = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
	);
	const plaintext = sodium.from_string(JSON.stringify(content));
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		plaintext,
		null,
		null,
		nonce,
		msgKey,
	);

	return {
		v: 1,
		nonce: sodium.to_base64(nonce),
		ciphertext: sodium.to_base64(ciphertext),
	};
}

export async function decryptContent(
	encrypted: EncryptedContent,
	msgKey: Uint8Array,
): Promise<MessageContent> {
	await ensureSodium();
	const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		sodium.from_base64(encrypted.ciphertext),
		null,
		sodium.from_base64(encrypted.nonce),
		msgKey,
	);

	return JSON.parse(sodium.to_string(plain)) as MessageContent;
}

export async function encryptText(
	plaintext: string,
	msgKey: Uint8Array,
): Promise<EncryptedText> {
	await ensureSodium();
	const nonce = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
	);
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		sodium.from_string(plaintext),
		null,
		null,
		nonce,
		msgKey,
	);

	return {
		nonce: sodium.to_base64(nonce),
		ciphertext: sodium.to_base64(ciphertext),
	};
}

export async function decryptText(
	ciphertext: string,
	nonce: string,
	msgKey: Uint8Array,
): Promise<string> {
	await ensureSodium();
	const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		sodium.from_base64(ciphertext),
		null,
		sodium.from_base64(nonce),
		msgKey,
	);
	return sodium.to_string(plain);
}
