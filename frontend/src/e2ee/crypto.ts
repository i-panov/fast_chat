import sodium from "libsodium-wrappers";

const BASE64_PADDING = /=+$/;

import type { FileKey } from "./file-crypto.ts";

export interface Envelope {
	keyId: string;
	box: string; // base64 sealed/boxed message key
	// v2: per-recipient nonce for crypto_box_easy. Absent in legacy v1
	// envelopes, which use an anonymous sealed box.
	nonce?: string;
}

export interface EncryptedPayload {
	v: 1 | 2;
	nonce: string; // base64 content nonce
	// v2: the sender's X25519 public key and the account identity key that
	// signs it. The recipient pins the identity key on first use.
	senderKey?: string;
	identityKey?: string;
	identitySig?: string;
	envelopes: Envelope[];
}

// samePublicKey compares key material by decoded bytes: the server stores
// padded StdEncoding while libsodium emits URL-safe unpadded text.
export function samePublicKey(left: string, right: string): boolean {
	try {
		const a = decodeBase64(left);
		const b = decodeBase64(right);
		return a.length === b.length && a.every((byte, index) => byte === b[index]);
	} catch {
		return left === right;
	}
}

export interface KeyPair {
	publicKey: string; // base64 X25519
	privateKey: string; // base64 X25519
}

// IdentityKeyPair is the long-lived Ed25519 account identity. It signs the
// per-device X25519 sender key, so a second device of the same account does
// not look like a key substitution.
export interface IdentityKeyPair {
	publicKey: string; // base64 Ed25519
	privateKey: string; // base64 Ed25519
}

let readyPromise: Promise<void> | null = null;

export function ensureSodium(): Promise<void> {
	if (readyPromise === null) {
		readyPromise = sodium.ready;
	}
	return readyPromise;
}

export async function generateIdentityKeyPair(): Promise<IdentityKeyPair> {
	await ensureSodium();
	const pair = sodium.crypto_sign_keypair();
	return {
		publicKey: sodium.to_base64(pair.publicKey),
		privateKey: sodium.to_base64(pair.privateKey),
	};
}

// signSenderBinding signs the device key together with the message binding.
// The signature proves that the holder of the account identity vouches for
// this particular sender key in this particular chat/message.
export async function signSenderBinding(
	identity: IdentityKeyPair,
	aad: string,
	senderKey: string,
): Promise<string> {
	await ensureSodium();
	const message = sodium.from_string(senderBindingMessage(aad, senderKey));
	const signature = sodium.crypto_sign_detached(
		message,
		decodeBase64(identity.privateKey),
	);
	return sodium.to_base64(signature);
}

export async function verifySenderBinding(
	identityPublicKey: string,
	aad: string,
	senderKey: string,
	signature: string,
): Promise<boolean> {
	await ensureSodium();
	try {
		return sodium.crypto_sign_verify_detached(
			decodeBase64(signature),
			sodium.from_string(senderBindingMessage(aad, senderKey)),
			decodeBase64(identityPublicKey),
		);
	} catch {
		return false;
	}
}

function senderBindingMessage(aad: string, senderKey: string): string {
	return `${aad}|${senderKey}`;
}

export async function generateKeyPair(): Promise<KeyPair> {
	await ensureSodium();
	const kp = sodium.crypto_box_keypair();
	return {
		publicKey: sodium.to_base64(kp.publicKey),
		privateKey: sodium.to_base64(kp.privateKey),
	};
}

// Server-stored keys use padded standard base64, while libsodium emits
// URL-safe unpadded values. Accept both instead of relying on one variant.
export function decodeBase64(value: string): Uint8Array {
	const normalized = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.replace(BASE64_PADDING, "");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Seal the message key to every recipient's public key. With senderKeys the
// envelope is an authenticated crypto_box_easy: only the sender (holder of
// senderKeys.privateKey) could have produced it. Without it the legacy
// anonymous sealed box is used (v1).
export async function sealMessageKey(
	msgKey: Uint8Array,
	recipients: Array<{ keyId: string; publicKey: string }>,
	senderKeys?: KeyPair,
): Promise<Envelope[]> {
	await ensureSodium();

	if (senderKeys === undefined) {
		return recipients.map((r) => ({
			keyId: r.keyId,
			box: sodium.to_base64(
				sodium.crypto_box_seal(msgKey, decodeBase64(r.publicKey)),
			),
		}));
	}

	const senderPrivateKey = decodeBase64(senderKeys.privateKey);

	return recipients.map((r) => {
		const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
		return {
			keyId: r.keyId,
			nonce: sodium.to_base64(nonce),
			box: sodium.to_base64(
				sodium.crypto_box_easy(
					msgKey,
					nonce,
					decodeBase64(r.publicKey),
					senderPrivateKey,
				),
			),
		};
	});
}

// openMessageKeyV2 opens an authenticated envelope: senderPublicKey proves
// the sender's authorship, recipient private key makes it readable here.
export async function openMessageKeyV2(
	envelope: Envelope,
	senderPublicKey: string,
	recipientPrivateKey: string,
): Promise<Uint8Array> {
	await ensureSodium();
	if (envelope.nonce === undefined) {
		throw new Error("missing envelope nonce");
	}

	return sodium.crypto_box_open_easy(
		decodeBase64(envelope.box),
		decodeBase64(envelope.nonce),
		decodeBase64(senderPublicKey),
		decodeBase64(recipientPrivateKey),
	);
}

export async function openMessageKey(
	envelope: Envelope,
	publicKey: string,
	privateKey: string,
): Promise<Uint8Array> {
	await ensureSodium();
	return sodium.crypto_box_seal_open(
		decodeBase64(envelope.box),
		decodeBase64(publicKey),
		decodeBase64(privateKey),
	);
}

export interface EncryptedText {
	nonce: string;
	ciphertext: string;
}

// FileMeta describes a file without revealing its content. It travels inside
// the encrypted message content because the server only ever sees the
// ciphertext of an encrypted upload: without it the type of an encrypted
// photo would be lost and the attachment would show up as an unknown file.
export interface FileMeta {
	mimeType: string;
	name: string;
	size: number;
}

// MessageContent holds every sensitive field of a message. The whole struct
// is serialised to JSON and encrypted as a single blob, so the server never
// sees plaintext text, location, file metadata, or reply previews.
export interface MessageContent {
	text: string;
	replyMarkup?: import("../types/api.ts").InlineKeyboardMarkup;
	location?: { lat: number; lng: number };
	replyToText?: string;
	// fileKeys maps file ID to its decryption key. Only encrypted files have
	// an entry; unencrypted files are absent (download as-is).
	fileKeys?: Record<string, FileKey>;
	// fileMeta maps the plaintext hash of a file to its metadata. The hash is
	// the key because the server assigns a different file id to the same
	// content for every account.
	fileMeta?: Record<string, FileMeta>;
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
	aad?: string,
): Promise<EncryptedContent> {
	await ensureSodium();
	const nonce = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
	);
	const plaintext = sodium.from_string(JSON.stringify(content));
	const additionalData = aad === undefined ? null : sodium.from_string(aad);
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		plaintext,
		additionalData,
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
	aad?: string,
): Promise<MessageContent> {
	await ensureSodium();
	const additionalData = aad === undefined ? null : sodium.from_string(aad);
	const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		decodeBase64(encrypted.ciphertext),
		additionalData,
		decodeBase64(encrypted.nonce),
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
		decodeBase64(ciphertext),
		null,
		decodeBase64(nonce),
		msgKey,
	);
	return sodium.to_string(plain);
}
