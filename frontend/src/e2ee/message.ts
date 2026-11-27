import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import i18n from "../i18n.ts";
import type { FileInfo, InlineKeyboardMarkup, Message } from "../types/api.ts";
import { fileTypeForMime } from "../utils/fileType.ts";
import { messageAAD } from "./chat-encrypt.ts";
import {
	decryptContent,
	type EncryptedPayload,
	type FileMeta,
	type KeyPair,
	openMessageKeyV2,
	samePublicKey,
	verifySenderBinding,
} from "./crypto.ts";
import type { FileKey } from "./file-crypto.ts";
import {
	getAccountScope,
	getIdentityHistory,
	getIdentityKeyPair,
	getKeyHistory,
	getMyKeyVersion,
	reportStaleEnvelopeVersion,
} from "./keys.ts";

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

const identityPin = (userId: string) => `e2ee.identity.${userId}`;
const identityTrust = (userId: string) => `e2ee.identityTrust.${userId}`;

// Trust-on-first-use for the account identity. The device key may change
// (new browser, recovered backup); the identity is what must stay stable.
async function pinSenderIdentity(
	fromId: string,
	identityKey: string,
	viewerId: string,
	chain?: Array<{ from: string; to: string; signature: string }>,
): Promise<void> {
	const scope = getAccountScope();
	// Own messages must still carry our identity (current or historical):
	// otherwise the server could forge a message "from me" with its own key.
	if (fromId === viewerId) {
		const own = await getIdentityKeyPair(scope);
		if (own !== null && samePublicKey(own.publicKey, identityKey)) return;
		const history = await getIdentityHistory(scope);
		if (history.some((key) => samePublicKey(key, identityKey))) return;
		// Another device of this account may have rotated the signing key.
		// Accept the same signed chain peers would use.
		const starts = [...(own === null ? [] : [own.publicKey]), ...history];
		for (const start of starts) {
			let current = start;
			for (const link of chain ?? []) {
				if (!samePublicKey(link.from, current)) continue;
				const valid = await verifySenderBinding(
					current,
					`identity-rotation:${current}`,
					link.to,
					link.signature,
				);
				if (!valid) throw new Error("invalid identity rotation");
				current = link.to;
				if (samePublicKey(current, identityKey)) return;
			}
		}
		// No local identity at all (legacy or test state): nothing to compare.
		if (own === null && history.length === 0) return;
		throw new Error("own sender identity mismatch");
	}

	const pinned = await metaRepo.getFor(scope, identityPin(fromId));
	if (typeof pinned === "string" && pinned !== "") {
		if (samePublicKey(pinned, identityKey)) return;
		const trusted = await metaRepo.getFor(scope, identityTrust(fromId));
		if (
			Array.isArray(trusted) &&
			trusted.some(
				(value): value is string =>
					typeof value === "string" && samePublicKey(value, identityKey),
			)
		) {
			return;
		}
		// Walk the sender-provided rotation chain from the pinned identity.
		// Only cryptographically verified hops become trusted; unrelated links
		// in the same (attacker-controlled) array are ignored.
		let current = pinned;
		const verified = [pinned];
		for (const link of chain ?? []) {
			if (!samePublicKey(link.from, current)) continue;
			const valid = await verifySenderBinding(
				current,
				`identity-rotation:${current}`,
				link.to,
				link.signature,
			);
			if (!valid) throw new Error("invalid identity rotation");
			current = link.to;
			verified.push(current);
			if (samePublicKey(current, identityKey)) {
				const known = Array.isArray(trusted)
					? trusted.filter(
							(value): value is string => typeof value === "string",
						)
					: [];
				await metaRepo.setNoNotifyFor(scope, identityPin(fromId), identityKey);
				await metaRepo.setNoNotifyFor(scope, identityTrust(fromId), [
					...new Set([...known, ...verified]),
				]);
				return;
			}
		}
		throw new Error("sender identity changed");
	}
	await metaRepo.setNoNotifyFor(scope, identityPin(fromId), identityKey);
	await metaRepo.setNoNotifyFor(scope, identityTrust(fromId), [identityKey]);
}

// openBoundV3 validates the identity signature and returns the AAD string.
// Every field of the binding is required: without them neither the AEAD nor
// the signature can prove where the ciphertext belongs.
async function openBoundV3(
	payload: EncryptedPayload,
	msg: EncryptedContentSource,
): Promise<string> {
	const { senderKey, identityKey, identitySig } = payload;
	const { chatId, id, fromId } = msg;
	if (
		senderKey === undefined ||
		identityKey === undefined ||
		identitySig === undefined ||
		chatId === undefined ||
		id === undefined ||
		fromId === undefined
	) {
		throw new Error("v3 message is missing its binding fields");
	}
	const aad = messageAAD({
		chatId,
		messageId: id,
		fromId,
		threadId: msg.threadId,
	});
	if (!(await verifySenderBinding(identityKey, aad, senderKey, identitySig))) {
		throw new Error("sender identity signature is invalid");
	}
	// The identity is pinned only after the envelope actually opens and the
	// content decrypts: a forged, unreadable record must not claim the peer's
	// identity forever.
	return aad;
}

async function openAnyEnvelope(
	payload: EncryptedPayload,
	userId: string,
	key: KeyPair,
): Promise<Uint8Array> {
	// Only this account's envelopes can be opened. Envelopes for other
	// participants are skipped without touching IndexedDB.
	const own = payload.envelopes.filter((envelope) => envelope.keyId === userId);
	const newestOwnVersion =
		own.length > 0
			? Math.max(...own.map((envelope) => envelope.keyVersion))
			: 0;
	const currentVersion = await getMyKeyVersion();
	const history = own.some((envelope) => envelope.keyVersion !== currentVersion)
		? await getKeyHistory()
		: [];
	for (const envelope of own) {
		const versioned =
			envelope.keyVersion === currentVersion
				? key
				: (history.find((entry) => entry.version === envelope.keyVersion)
						?.keyPair ?? null);
		// A stale local version marker can point at the wrong history entry.
		// Try the current key as well so a partially desynced device still
		// reads messages instead of losing them entirely.
		const candidates =
			versioned !== null && versioned.privateKey !== key.privateKey
				? [versioned, key]
				: [key];
		for (const recipientKey of candidates) {
			try {
				return await openMessageKeyV2(
					envelope,
					payload.senderKey,
					recipientKey.privateKey,
				);
			} catch {
				// The envelope belongs to another version; try the next candidate.
			}
		}
	}
	if (newestOwnVersion > currentVersion) {
		void reportStaleEnvelopeVersion(newestOwnVersion);
	}
	throw new Error("no envelope for this key");
}

// EncryptedContentSource is the subset of a message needed to decrypt v3
// content. The binding fields are optional in the type because some callers
// hold partial records; a v3 payload missing any of them fails closed.
export interface EncryptedContentSource {
	text: string;
	encryptedPayload?: string;
	location?: { lat: number; lng: number };
	chatId?: string;
	id?: string;
	fromId?: string;
	threadId?: string;
}

// decryptMessageContent decrypts the full content (text, location, file keys)
// from the message's encrypted payload. Returns null if there is no payload or
// decryption fails.
export async function decryptMessageContent(
	msg: EncryptedContentSource,
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

	// encryptedPayload carries the msgKey envelopes + content nonce.
	const payload = JSON.parse(msg.encryptedPayload) as EncryptedPayload;
	if (payload.v !== 3) {
		throw new Error("unsupported encrypted payload version");
	}
	const aad = await openBoundV3(payload, msg);
	const msgKey = await openAnyEnvelope(payload, userId, key);

	try {
		const content = await decryptContent(
			{ v: 1, nonce: payload.nonce, ciphertext: msg.text },
			msgKey,
			aad,
		);

		if (typeof content.text !== "string") return null;
		if (msg.fromId !== undefined) {
			await pinSenderIdentity(
				msg.fromId,
				payload.identityKey,
				userId,
				payload.identityChain,
			);
		}
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
		// hasOwn, not ?.[hash]: a server-controlled hash such as "__proto__"
		// would otherwise resolve to Object.prototype and pass the
		// authentication filter in decryptMessage.
		const meta =
			file.hash !== undefined && Object.hasOwn(fileMeta, file.hash)
				? fileMeta[file.hash]
				: undefined;
		if (
			meta === undefined ||
			typeof meta.mimeType !== "string" ||
			typeof meta.name !== "string" ||
			typeof meta.size !== "number"
		) {
			return file;
		}

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
	msg: EncryptedContentSource & { encrypted?: boolean },
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
	const serverFiles = message.files;
	// Server-controlled fields on an encrypted message are not authenticated
	// until the content is decrypted.
	out.files = undefined;
	out.location = undefined;
	out.replyMarkup = undefined;
	if (message.replyTo !== undefined) {
		out.replyTo = { ...message.replyTo, files: undefined, location: undefined };
	}

	if (
		message.encrypted &&
		(message.encryptedPayload === undefined || message.encryptedPayload === "")
	) {
		// Fail closed: a record marked encrypted without an envelope is
		// server-controlled and must never be rendered as plaintext.
		out.text = i18n.t(UNDECRYPTABLE_I18N_KEY);
		out.undecryptable = true;
		if (message.replyTo !== undefined) {
			out.replyTo = {
				...message.replyTo,
				text: "",
				files: undefined,
				location: undefined,
			};
		}
		return out;
	}

	if (key === null) {
		out.text = i18n.t(UNDECRYPTABLE_I18N_KEY);
		out.undecryptable = true;
		if (message.replyTo !== undefined) {
			out.replyTo = {
				...message.replyTo,
				text: i18n.t(UNDECRYPTABLE_I18N_KEY),
				files: undefined,
				location: undefined,
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
			const authenticatedFiles = (serverFiles ?? []).filter(
				(file) =>
					file.hash !== undefined &&
					Object.hasOwn(content.fileMeta ?? {}, file.hash),
			);
			out.files = applyFileMeta(
				authenticatedFiles.length > 0 ? authenticatedFiles : undefined,
				content.fileMeta ?? {},
			);
		} else {
			out.text = i18n.t(UNDECRYPTABLE_I18N_KEY);
			out.undecryptable = true;
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
					const content = await decryptMessageContent(parent, userId, key);
					parentText =
						content !== null ? content.text : i18n.t(UNDECRYPTABLE_I18N_KEY);
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
			files: undefined,
			location: undefined,
		};
	}

	return out;
}
