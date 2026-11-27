import sodium from "libsodium-wrappers";

export interface EncryptionKeyPair {
	publicKey: string;
	privateKey: string;
}

interface Envelope {
	keyId: string;
	keyVersion: number;
	box: string;
	nonce: string;
}

interface EncryptedPayload {
	v: 3;
	nonce: string;
	senderKey: string;
	identityKey: string;
	identitySig: string;
	envelopes: Envelope[];
}

export interface MessageBinding {
	chatId: string;
	messageId: string;
	fromId: string;
	threadId?: string;
}

export function messageAAD(binding: MessageBinding): string {
	return [
		binding.chatId,
		binding.messageId,
		binding.fromId,
		binding.threadId ?? "",
	].join("|");
}

interface DeviceKey {
	id: string;
	publicKey: string;
	keyVersion?: number;
}

export interface FileKey {
	nonce: string;
	key: string;
}

export interface FileMeta {
	mimeType: string;
	name: string;
	size: number;
}

export interface ReplyButton {
	text: string;
	callbackData?: string;
	url?: string;
}

export type ReplyMarkup = ReplyButton[][];

function decodeBase64(value: string): Uint8Array {
	const normalized = value
		.replace(/-/g, "+")
		.replace(/_/g, "/")
		.replace(/=+$/, "");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

// Signing private keys travel as a 32-byte seed so Python/PyNaCl can read
// them too (libsodium's native secret key is 64 bytes).
function seedKeypair(seed: Uint8Array): {
	publicKey: Uint8Array;
	privateKey: Uint8Array;
} {
	// libsodium-wrappers ships the function but its typings omit it.
	const fn = (
		sodium as unknown as {
			crypto_sign_seed_keypair(seed: Uint8Array): {
				publicKey: Uint8Array;
				privateKey: Uint8Array;
			};
		}
	).crypto_sign_seed_keypair;
	return fn(seed);
}

function signingSecretKey(privateKey: string): Uint8Array {
	const raw = decodeBase64(privateKey);
	if (raw.length === 64) return raw;
	return seedKeypair(raw).privateKey;
}

export async function generateSigningKeyPair(): Promise<EncryptionKeyPair> {
	await sodium.ready;
	const seed = sodium.randombytes_buf(32);
	const pair = seedKeypair(seed);
	return {
		publicKey: sodium.to_base64(pair.publicKey),
		privateKey: sodium.to_base64(seed),
	};
}

export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
	await sodium.ready;
	const pair = sodium.crypto_box_keypair();
	return {
		publicKey: sodium.to_base64(pair.publicKey),
		privateKey: sodium.to_base64(pair.privateKey),
	};
}

export interface BotContent {
	text: string;
	replyMarkup?: unknown;
	location?: { lat: number; lng: number };
	fileKeys?: Record<string, FileKey>;
	fileMeta?: Record<string, FileMeta>;
}

export async function decryptBotMessage(
	text: string,
	payloadJSON: string,
	botID: string,
	key: EncryptionKeyPair,
	binding: MessageBinding,
): Promise<BotContent> {
	await sodium.ready;
	const payload = JSON.parse(payloadJSON) as EncryptedPayload;
	if (payload.v !== 3) {
		throw new Error("unsupported encrypted payload version");
	}

	const aadText = messageAAD(binding);
	const signed = new TextEncoder().encode(`${aadText}|${payload.senderKey}`);
	const valid = sodium.crypto_sign_verify_detached(
		decodeBase64(payload.identitySig),
		signed,
		decodeBase64(payload.identityKey),
	);
	if (!valid) throw new Error("sender identity signature is invalid");

	for (const envelope of payload.envelopes) {
		if (envelope.keyId !== botID) continue;
		try {
			const msgKey = sodium.crypto_box_open_easy(
				decodeBase64(envelope.box),
				decodeBase64(envelope.nonce),
				decodeBase64(payload.senderKey),
				decodeBase64(key.privateKey),
			);
			const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
				null,
				decodeBase64(text),
				new TextEncoder().encode(aadText),
				decodeBase64(payload.nonce),
				msgKey,
			);
			return JSON.parse(new TextDecoder().decode(plain)) as BotContent;
		} catch {
			// Try the next envelope.
		}
	}
	throw new Error("no bot envelope");
}

export async function encryptBotReply(
	text: string,
	devices: DeviceKey[],
	markup: ReplyMarkup | undefined,
	extra: {
		location?: { lat: number; lng: number };
		fileKeys?: Record<string, FileKey>;
		fileMeta?: Record<string, FileMeta>;
	} | undefined,
	options: {
		binding: MessageBinding;
		encryptionKey: EncryptionKeyPair;
		identityKey: EncryptionKeyPair;
	},
): Promise<{ text: string; payload: string }> {
	await sodium.ready;
	if (devices.length === 0) throw new Error("no user device keys");
	const msgKey = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
	);
	const nonce = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
	);
	const content: Record<string, unknown> = { text };
	if (extra?.location !== undefined) content.location = extra.location;
	if (extra?.fileKeys !== undefined) content.fileKeys = extra.fileKeys;
	if (extra?.fileMeta !== undefined) content.fileMeta = extra.fileMeta;
	if (markup !== undefined) {
		content.replyMarkup = {
			inline_keyboard: markup.map((row) =>
				row.map((button) => ({
					text: button.text,
					callback_data: button.callbackData,
					url: button.url,
				})),
			),
		};
	}
	const aadText = messageAAD(options.binding);
	const plain = new TextEncoder().encode(JSON.stringify(content));
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		plain,
		new TextEncoder().encode(aadText),
		null,
		nonce,
		msgKey,
	);
	const envelopes = devices.map((device) => {
		const envelopeNonce = sodium.randombytes_buf(24);
		return {
			keyId: device.id,
			keyVersion: device.keyVersion ?? 1,
			box: sodium.to_base64(
				sodium.crypto_box_easy(
					msgKey,
					envelopeNonce,
					decodeBase64(device.publicKey),
					decodeBase64(options.encryptionKey.privateKey),
				),
			),
			nonce: sodium.to_base64(envelopeNonce),
		};
	});
	const signature = sodium.crypto_sign_detached(
		new TextEncoder().encode(`${aadText}|${options.encryptionKey.publicKey}`),
		signingSecretKey(options.identityKey.privateKey),
	);
	const payload: EncryptedPayload = {
		v: 3,
		nonce: sodium.to_base64(nonce),
		senderKey: options.encryptionKey.publicKey,
		identityKey: options.identityKey.publicKey,
		identitySig: sodium.to_base64(signature),
		envelopes,
	};
	return { text: sodium.to_base64(ciphertext), payload: JSON.stringify(payload) };
}

export async function encryptCallbackData(
	data: string,
	botPublicKey: string,
): Promise<string> {
	await sodium.ready;
	const sealed = sodium.crypto_box_seal(
		new TextEncoder().encode(data),
		decodeBase64(botPublicKey),
	);
	return "fcbenc:" + sodium.to_base64(sealed);
}

export async function decryptCallbackData(
	data: string,
	key: EncryptionKeyPair,
): Promise<string> {
	if (!data.startsWith("fcbenc:")) return data;
	await sodium.ready;
	const plain = sodium.crypto_box_seal_open(
		decodeBase64(data.slice("fcbenc:".length)),
		decodeBase64(key.publicKey),
		decodeBase64(key.privateKey),
	);
	return new TextDecoder().decode(plain);
}

export async function generateFileKey(): Promise<FileKey> {
	await sodium.ready;
	return {
		nonce: sodium.to_base64(
			sodium.randombytes_buf(
				sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
			),
		),
		key: sodium.to_base64(
			sodium.randombytes_buf(
				sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
			),
		),
	};
}

export async function hashBytes(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

export async function encryptFileBytes(
	data: Uint8Array,
	fileKey: FileKey,
): Promise<Uint8Array> {
	await sodium.ready;
	return sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		data,
		null,
		null,
		decodeBase64(fileKey.nonce),
		decodeBase64(fileKey.key),
	);
}

export async function decryptFileBytes(
	ciphertext: Uint8Array,
	fileKey: FileKey,
): Promise<Uint8Array> {
	await sodium.ready;
	return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		ciphertext,
		null,
		decodeBase64(fileKey.nonce),
		decodeBase64(fileKey.key),
	);
}
