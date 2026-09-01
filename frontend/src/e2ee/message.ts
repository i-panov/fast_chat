import sodium from "libsodium-wrappers";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import i18n from "../i18n.ts";
import type { Message } from "../types/api.ts";
import {
	decryptContent,
	decryptText,
	type EncryptedPayload,
	encryptText,
	ensureSodium,
	type KeyPair,
	openMessageKey,
	sealMessageKey,
} from "./crypto.ts";

export interface EncryptResult {
	text: string; // base64 ciphertext
	encryptedPayload: string; // JSON payload
}

const UNDECRYPTABLE_I18N_KEY = "message.undecryptable";

// encryptMessageText encrypts plaintext to every recipient's public key
// and returns the ciphertext plus the envelope payload. Only the holder
// of a recipient's private key can open its envelope.
export async function encryptMessageText(
	plaintext: string,
	recipients: Array<{ keyId: string; publicKey: string }>,
): Promise<EncryptResult> {
	await ensureSodium();
	const msgKey = sodium.randombytes_buf(
		sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
	);
	const { nonce, ciphertext } = await encryptText(plaintext, msgKey);
	const envelopes = await sealMessageKey(msgKey, recipients);
	const payload: EncryptedPayload = { v: 1, nonce, envelopes };

	return { text: ciphertext, encryptedPayload: JSON.stringify(payload) };
}

// decryptMessageText decrypts a single message's ciphertext using the
// user's own envelope.
export async function decryptMessageText(
	msg: Pick<Message, "text" | "encryptedPayload">,
	userId: string,
	key: KeyPair,
): Promise<string> {
	if (!msg.encryptedPayload) return msg.text;

	const payload = JSON.parse(msg.encryptedPayload) as EncryptedPayload;
	const envelope = payload.envelopes.find((e) => e.keyId === userId);
	if (envelope === undefined) {
		throw new Error("no envelope for user");
	}

	const msgKey = await openMessageKey(envelope, key.publicKey, key.privateKey);
	return decryptText(msg.text, payload.nonce, msgKey);
}

// decryptMessageContent decrypts the full content (text, location, file keys)
// from the message's encrypted payload. Returns null if the message uses the
// legacy v1 format (text-only encryption) or if decryption fails.
export async function decryptMessageContent(
	msg: Pick<Message, "text" | "encryptedPayload" | "location">,
	userId: string,
	key: KeyPair,
): Promise<{ text: string; location?: { lat: number; lng: number } } | null> {
	if (!msg.encryptedPayload) return null;

	// encryptedPayload carries the sealed msgKey envelopes + nonce.
	const payload = JSON.parse(msg.encryptedPayload) as EncryptedPayload;
	const envelope = payload.envelopes.find((e) => e.keyId === userId);
	if (envelope === undefined) {
		return null;
	}

	const msgKey = await openMessageKey(envelope, key.publicKey, key.privateKey);

	try {
		const content = await decryptContent(
			{ v: 1, nonce: payload.nonce, ciphertext: msg.text },
			msgKey,
		);

		return {
			text: content.text,
			location: content.location,
		};
	} catch {
		return null;
	}
}

// decryptMessage returns a copy of the message with the plaintext text,
// location, and reply preview resolved. Legacy (non-encrypted) messages pass
// through untouched; undecryptable ones get a placeholder.
export type EncryptedMessageLike = Omit<Message, "status"> & {
	status?: string;
	threadId?: string;
	_updatedAt?: string;
};

function toMessage(m: EncryptedMessageLike): Message {
	return {
		id: m.id,
		chatId: m.chatId,
		fromId: m.fromId,
		fromNick: m.fromNick,
		text: m.text,
		encrypted: m.encrypted,
		encryptedPayload: m.encryptedPayload,
		createdAt: m.createdAt,
		editedAt: m.editedAt,
		replyTo: m.replyTo,
		files: m.files,
		location: m.location,
		deliveryStatus: m.deliveryStatus,
		readBy: m.readBy,
	};
}

export async function decryptMessage(
	message: EncryptedMessageLike,
	userId: string,
	key: KeyPair | null,
): Promise<Message> {
	if (!message.encrypted) return toMessage(message);

	const out = toMessage(message);

	if (key === null) {
		out.text = i18n.t(UNDECRYPTABLE_I18N_KEY);
		out.undecryptable = true;
		if (message.replyTo !== undefined) {
			out.replyTo = {
				...message.replyTo,
				text: i18n.t(UNDECRYPTABLE_I18N_KEY),
			};
		}

		return out;
	}

	try {
		// Try the new content format first (v2 with location + file keys).
		const content = await decryptMessageContent(message, userId, key);
		if (content !== null) {
			out.text = content.text;
			out.location = content.location;
		} else {
			// Fall back to legacy v1 (text-only encryption).
			out.text = await decryptMessageText(message, userId, key);
		}
	} catch {
		out.text = i18n.t(UNDECRYPTABLE_I18N_KEY);
		out.undecryptable = true;
	}

	if (message.replyTo !== undefined) {
		let parentText = "";
		try {
			const parent =
				(await messagesRepo.getByIdAny(message.replyTo.messageId)) ??
				(await threadMessagesRepo.getByIdAny(message.replyTo.messageId));

			if (parent !== undefined) {
				if (parent.encrypted) {
					parentText = await decryptMessageText(parent, userId, key);
				} else {
					parentText = parent.text;
				}
			}
		} catch {
			parentText = i18n.t(UNDECRYPTABLE_I18N_KEY);
		}

		out.replyTo = {
			...message.replyTo,
			text: parentText,
		};
	}

	return out;
}
