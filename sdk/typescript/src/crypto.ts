import sodium from "libsodium-wrappers";

export interface EncryptionKeyPair {
	publicKey: string;
	privateKey: string;
}

interface Envelope {
	keyId: string;
	box: string;
}

interface EncryptedPayload {
	v: 1;
	nonce: string;
	envelopes: Envelope[];
}

interface DeviceKey {
	id: string;
	publicKey: string;
}

export interface ReplyButton {
	text: string;
	callbackData?: string;
	url?: string;
}

export type ReplyMarkup = ReplyButton[][];

export async function generateEncryptionKeyPair(): Promise<EncryptionKeyPair> {
	await sodium.ready;
	const pair = sodium.crypto_box_keypair();
	return {
		publicKey: sodium.to_base64(pair.publicKey),
		privateKey: sodium.to_base64(pair.privateKey),
	};
}

export async function decryptBotMessage(
	text: string,
	payloadJSON: string,
	botID: string,
	key: EncryptionKeyPair,
): Promise<{ text: string; replyMarkup?: unknown }> {
	await sodium.ready;
	const payload = JSON.parse(payloadJSON) as EncryptedPayload;
	for (const envelope of payload.envelopes) {
		if (envelope.keyId !== botID) continue;
		try {
			const msgKey = sodium.crypto_box_seal_open(
				sodium.from_base64(envelope.box),
				sodium.from_base64(key.publicKey),
				sodium.from_base64(key.privateKey),
			);
			const plain = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
				null,
				sodium.from_base64(text),
				null,
				sodium.from_base64(payload.nonce),
				msgKey,
			);
			return JSON.parse(new TextDecoder().decode(plain)) as {
				text: string;
				replyMarkup?: unknown;
			};
		} catch {
			// Try the next envelope.
		}
	}
	throw new Error("no bot envelope");
}

export async function encryptBotReply(
	text: string,
	devices: DeviceKey[],
	markup?: ReplyMarkup,
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
	const plain = new TextEncoder().encode(JSON.stringify(content));
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		plain,
		null,
		null,
		nonce,
		msgKey,
	);
	const envelopes = devices.map((device) => ({
		keyId: device.id,
		box: sodium.to_base64(
			sodium.crypto_box_seal(msgKey, sodium.from_base64(device.publicKey)),
		),
	}));
	const payload: EncryptedPayload = {
		v: 1,
		nonce: sodium.to_base64(nonce),
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
		sodium.from_base64(botPublicKey),
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
		sodium.from_base64(data.slice("fcbenc:".length)),
		sodium.from_base64(key.publicKey),
		sodium.from_base64(key.privateKey),
	);
	return new TextDecoder().decode(plain);
}
