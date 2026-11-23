import sodium from "libsodium-wrappers";
import { messagesRepo } from "../db/messagesRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import i18n from "../i18n.ts";
import type { FileInfo, InlineKeyboardMarkup, Message } from "../types/api.ts";
import { fileTypeForMime } from "../utils/fileType.ts";
import {
	decryptContent,
	decryptText,
	type EncryptedPayload,
	encryptText,
	ensureSodium,
	type FileMeta,
	type KeyPair,
	openMessageKey,
	sealMessageKey,
} from "./crypto.ts";
import type { FileKey } from "./file-crypto.ts";

export interface EncryptResult {
	text: string; // base64 ciphertext
	encryptedPayload: string; // JSON payload
}

const UNDECRYPTABLE_I18N_KEY = "message.undecryptable";

function sanitizeLocation(value: unknown): Message["location"] {
	if (value === null || typeof value !== "object") return;
	const lat = (value as { lat?: unknown }).lat;
	const lng = (value as { lng?: unknown }).lng;
	if (
		typeof lat !== "number" ||
		typeof lng !== "number" ||
		!Number.isFinite(lat) ||
		!Number.isFinite(lng) ||
		lat < -90 ||
		lat > 90 ||
		lng < -180 ||
		lng > 180
	) {
		return;
	}
	return { lat, lng };
}

function sanitizeMarkup(value: unknown): InlineKeyboardMarkup | undefined {
	if (value === null || typeof value !== "object") return;
	const rows = (value as { inline_keyboard?: unknown }).inline_keyboard;
	if (!Array.isArray(rows) || rows.length > 8) return;
	const out: InlineKeyboardMarkup["inline_keyboard"] = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length > 8) return;
		const buttons: InlineKeyboardMarkup["inline_keyboard"][number] = [];
		for (const button of row) {
			if (button === null || typeof button !== "object") return;
			const text = (button as { text?: unknown }).text;
			const callbackData = (button as { callback_data?: unknown })
				.callback_data;
			const url = (button as { url?: unknown }).url;
			if (typeof text !== "string" || text.length === 0 || text.length > 64) {
				return;
			}
			if (typeof callbackData === "string" && typeof url === "string") return;
			if (typeof callbackData !== "string" && typeof url !== "string") return;
			if (typeof callbackData === "string" && callbackData.length > 256) return;
			if (
				typeof url === "string" &&
				!url.startsWith("http://") &&
				!url.startsWith("https://")
			) {
				return;
			}
			buttons.push({
				text,
				callback_data:
					typeof callbackData === "string" ? callbackData : undefined,
				url: typeof url === "string" ? url : undefined,
			});
		}
		out.push(buttons);
	}
	return { inline_keyboard: out };
}

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

async function openAnyEnvelope(
	payload: EncryptedPayload,
	userId: string,
	key: KeyPair,
): Promise<Uint8Array> {
	const ordered = [
		...payload.envelopes.filter((envelope) => envelope.keyId === userId),
		...payload.envelopes.filter((envelope) => envelope.keyId !== userId),
	];
	for (const envelope of ordered) {
		try {
			return await openMessageKey(envelope, key.publicKey, key.privateKey);
		} catch {
			// The envelope belongs to another device key; try the next one.
		}
	}
	throw new Error("no envelope for this key");
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
	const msgKey = await openAnyEnvelope(payload, userId, key);
	return decryptText(msg.text, payload.nonce, msgKey);
}

// decryptMessageContent decrypts the full content (text, location, file keys)
// from the message's encrypted payload. Returns null if the message uses the
// legacy v1 format (text-only encryption) or if decryption fails.
// Exported so edit flows can recover the kept files' keys without duplicating
// the v1/v2 detection logic.
export async function decryptMessageContent(
	msg: Pick<Message, "text" | "encryptedPayload" | "location">,
	userId: string,
	key: KeyPair,
): Promise<{
	text: string;
	location?: { lat: number; lng: number };
	fileKeys: Record<string, FileKey>;
	fileMeta: Record<string, FileMeta>;
	replyMarkup?: InlineKeyboardMarkup;
} | null> {
	if (!msg.encryptedPayload) return null;

	// encryptedPayload carries the sealed msgKey envelopes + nonce.
	const payload = JSON.parse(msg.encryptedPayload) as EncryptedPayload;
	const msgKey = await openAnyEnvelope(payload, userId, key);

	try {
		const content = await decryptContent(
			{ v: 1, nonce: payload.nonce, ciphertext: msg.text },
			msgKey,
		);

		if (typeof content.text !== "string") return null;
		return {
			text: content.text,
			location: sanitizeLocation(content.location),
			fileKeys: content.fileKeys ?? {},
			fileMeta: content.fileMeta ?? {},
			replyMarkup: sanitizeMarkup(content.replyMarkup),
		};
	} catch {
		return null;
	}
}

// applyFileMeta restores the type of the files the server could not classify.
// An encrypted upload reaches the server as ciphertext, so its sniffed MIME
// type is "application/octet-stream"; the sender knows the real one and
// carries it inside the encrypted content.
function applyFileMeta(
	files: FileInfo[] | undefined,
	fileMeta: Record<string, FileMeta>,
): FileInfo[] | undefined {
	if (files === undefined || Object.keys(fileMeta).length === 0) {
		return files;
	}

	return files.map((file) => {
		const meta = file.hash !== undefined ? fileMeta[file.hash] : undefined;
		if (meta === undefined) return file;

		return {
			...file,
			mimeType: meta.mimeType,
			originalName: meta.name !== "" ? meta.name : file.originalName,
			size: meta.size,
			fileType: fileTypeForMime(meta.mimeType),
		};
	});
}

// recoverKeptFileKeys decrypts the previous revision of an edited message
// and returns its fileKeys/fileMeta so kept attachments stay decryptable
// after the edit. Returns empty maps when there is nothing to recover
// (plaintext message, missing key, or undecryptable content) — never throws,
// so the edit itself always proceeds with at least the new files' keys.
export async function recoverKeptFileKeys(
	msg: Pick<Message, "text" | "encryptedPayload" | "location" | "encrypted">,
	userId: string,
	key: KeyPair | null,
): Promise<{
	fileKeys: Record<string, FileKey>;
	fileMeta: Record<string, FileMeta>;
}> {
	const empty = { fileKeys: {}, fileMeta: {} };
	if (msg.encrypted !== true || key === null) return empty;

	try {
		const content = await decryptMessageContent(msg, userId, key);
		if (content === null) return empty;
		return { fileKeys: content.fileKeys, fileMeta: content.fileMeta };
	} catch {
		return empty;
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
		threadId: m.threadId,
		fromId: m.fromId,
		fromNick: m.fromNick,
		text: m.text,
		encrypted: m.encrypted,
		encryptedPayload: m.encryptedPayload,
		createdAt: m.createdAt,
		editedAt: m.editedAt,
		replyTo: m.replyTo,
		replyMarkup: m.replyMarkup,
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
			out.replyMarkup = content.replyMarkup;
			out.fileKeys = content.fileKeys;
			out.files = applyFileMeta(out.files, content.fileMeta);
		} else {
			// Fall back to legacy v1 (text-only encryption), but do not
			// display a malformed v2 JSON payload as the message text.
			const legacy = await decryptMessageText(message, userId, key);
			if (legacy.trim().startsWith("{")) {
				try {
					const parsed: unknown = JSON.parse(legacy);
					if (
						parsed !== null &&
						typeof parsed === "object" &&
						("fileKeys" in parsed ||
							"replyMarkup" in parsed ||
							"text" in parsed)
					) {
						throw new Error("invalid encrypted content");
					}
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === "invalid encrypted content"
					) {
						throw error;
					}
				}
			}
			out.text = legacy;
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
					// The parent may use the v2 content format (text + location +
					// file keys) or legacy v1 text-only encryption. Try v2 first,
					// then fall back to v1 instead of assuming v1 unconditionally.
					const content = await decryptMessageContent(parent, userId, key);
					parentText =
						content !== null
							? content.text
							: await decryptMessageText(parent, userId, key);
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
