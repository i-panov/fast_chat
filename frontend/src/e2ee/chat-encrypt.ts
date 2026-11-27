import sodium from "libsodium-wrappers";
import { fileExistsByHash, getChatInfo } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import i18n from "../i18n.ts";
import type { Location, PendingFile } from "../types/api.ts";
import { emitNotification } from "../utils/notify.ts";
import {
	type Envelope,
	encryptContent,
	ensureSodium,
	type FileMeta,
	samePublicKey,
	sealMessageKey,
	signSenderBinding,
} from "./crypto.ts";
import type { FileKey } from "./file-crypto.ts";
import { encryptBytes, generateFileKey, hashBytes } from "./file-crypto.ts";
import {
	ensureAccountKeys,
	ensureIdentityKeys,
	getIdentityChain,
	getMyKeyVersion,
	getRecipientDeviceKeys,
	RecoveryRequiredError,
} from "./keys.ts";

export interface EncryptResult {
	ciphertext: string;
	nonce: string;
	envelopes: Envelope[];
	// v3: account-key envelopes and the identity signature.
	version: 3;
	senderKey: string;
	identityKey: string;
	identitySig: string;
	identityChain?: Array<{ from: string; to: string; signature: string }>;
}

// Message binding authenticated as AEAD associated data. The server may
// reorder or move ciphertext; any change to these fields makes decryption
// fail instead of producing a valid message in the wrong place. The timestamp
// is deliberately not bound: it is assigned by the server after encryption.
export function messageAAD(parts: {
	chatId: string;
	messageId: string;
	fromId: string;
	threadId?: string;
}): string {
	return [
		parts.chatId,
		parts.messageId,
		parts.fromId,
		parts.threadId ?? "",
	].join("|");
}

// encryptForChat encrypts the full message content (text, location, file keys)
// to every recipient's public key. The file keys are included in the encrypted
// blob so only recipients can decrypt both the content and the files.
// encryptForChat returns null for caller-actionable cases (no chat/session,
// a member without a key — already notified), rethrows RecoveryRequiredError
// so the UI can prompt for key recovery, and logs + notifies for unexpected
// failures (network/DB/crypto) instead of lumping everything as keyMissing.
export async function encryptForChat(
	token: string | undefined,
	chatId: string,
	content: { text: string; location?: Location },
	fileKeys: Record<string, FileKey>,
	fileMeta?: Record<string, FileMeta>,
	binding?: {
		messageId: string;
		fromId: string;
		threadId?: string;
	},
): Promise<EncryptResult | null> {
	try {
		const chat = await chatsRepo.getById(chatId);
		if (chat === undefined || token === undefined) return null;

		// The local member list can lag behind the server (a member just added
		// by another device): sealing only to the local list would make the
		// message unreadable for the new participant. Merge in the current
		// server list; offline, the cached list is the best available.
		const members = new Map(chat.members.map((m) => [m.id, m]));
		try {
			const { chat: fresh } = await getChatInfo(token, chatId);
			for (const m of fresh.members) members.set(m.id, m);
		} catch {
			// Offline or transient failure: keep the local snapshot.
		}
		const memberIds = [...members.keys()];
		if (memberIds.length === 0) {
			throw new Error("chat has no members");
		}
		const myKeys = await ensureAccountKeys(token);

		const deviceKeys = await getRecipientDeviceKeys(token, memberIds);
		const recipients: Array<{
			keyId: string;
			publicKey: string;
			keyVersion: number;
		}> = [];
		const missing: string[] = [];

		for (const id of memberIds) {
			const devices = deviceKeys.get(id);
			if (devices !== undefined && devices.length > 0) {
				for (const device of devices) {
					if (device.publicKey !== "") {
						recipients.push(device);
					}
				}
			} else {
				missing.push(id);
			}
		}

		// v3 has no unbound format: fail with the real reason before the
		// own-key check below reports a "missing key" for a caller bug.
		if (binding === undefined) {
			throw new Error("v3 encryption requires a message binding");
		}

		// The public-key cache may still hold this device's pre-rotation
		// key. The sender always knows its own current key.
		{
			const ownVersion = await getMyKeyVersion();
			const own = {
				keyId: binding.fromId,
				publicKey: myKeys.publicKey,
				keyVersion: ownVersion,
			};
			const idx = recipients.findIndex((r) => r.keyId === binding.fromId);
			if (idx === -1) recipients.push(own);
			else recipients.splice(idx, 1, own);
			// The own key is known locally even if the server did not return
			// it (deleted row, offline, failed upload).
			const ownMissing = missing.indexOf(binding.fromId);
			if (ownMissing !== -1) missing.splice(ownMissing, 1);
		}
		if (recipients.length === 0) {
			throw new Error("no recipient keys available");
		}

		// Without our own envelope the sender cannot read the message back.
		// This happens when this device's key was revoked or the server lost
		// it; fail closed instead of producing an unreadable message.
		if (
			!recipients.some((device) =>
				samePublicKey(device.publicKey, myKeys.publicKey),
			)
		) {
			throw new Error("own device key is missing from recipients");
		}

		const missingUnique = [...new Set(missing)];
		if (missingUnique.length > 0) {
			const nicks = missingUnique
				.map((id) => members.get(id))
				.filter((m) => m !== undefined)
				.map((m) => `@${m.nick}`)
				.join(", ");
			emitNotification(
				nicks !== ""
					? i18n.t("error.encryptionKeyMissingMembers", { members: nicks })
					: i18n.t("error.encryptionKeyMissing"),
			);
			return null;
		}

		await ensureSodium();
		const msgKey = sodium.randombytes_buf(
			sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
		);
		const contentBlob = {
			text: content.text,
			location: content.location,
			fileKeys,
			fileMeta,
		};
		const aad = messageAAD({
			chatId,
			messageId: binding.messageId,
			fromId: binding.fromId,
			threadId: binding.threadId,
		});
		const identity = await ensureIdentityKeys();
		const encrypted = await encryptContent(contentBlob, msgKey, aad);
		const envelopes = await sealMessageKey(msgKey, recipients, myKeys);

		const result: EncryptResult = {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			envelopes,
			version: 3,
			senderKey: myKeys.publicKey,
			identityKey: identity.publicKey,
			identitySig: await signSenderBinding(identity, aad, myKeys.publicKey),
			identityChain: await getIdentityChain(),
		};
		if (new TextEncoder().encode(JSON.stringify(result)).length > 60000) {
			emitNotification(i18n.t("error.groupTooLarge"));
			return null;
		}
		return result;
	} catch (err) {
		// Recovery must surface to the UI, not hide behind a generic notice.
		if (err instanceof RecoveryRequiredError) throw err;
		console.warn("encryptForChat failed:", err);
		emitNotification(i18n.t("error.encryptionKeyMissing"));
		return null;
	}
}

export interface PreparedFile {
	clientId: string;
	fileKey?: FileKey;
	plaintextHash: string;
	// onServer indicates the file already exists in the account's own files on
	// the server (matched by plaintext hash). No upload is needed; the message
	// only needs the hash.
	onServer?: boolean;
	// duplicate marks a repeated content in the same batch: it reuses the first
	// occurrence's key and upload instead of staging (and uploading) again.
	duplicate?: boolean;
	// fileMeta carries the client-side metadata of the file. It travels inside
	// the encrypted message content, because the server cannot know the type
	// of a file whose content it never sees.
	fileMeta?: FileMeta;
}

// MaxSendableFileSize mirrors the server's MaxUploadSize (50 MiB): bigger
// files can never upload, so they are rejected before any byte is read.
// Without this, a 500 MiB attachment would be fully read and encrypted
// (~1 GiB transient RAM for raw + ciphertext) only to fail server-side.
export const MaxSendableFileSize = 50 * 1024 * 1024;

// prepareFiles prepares each pending file for sending. It first checks whether
// the account already uploaded this content (by plaintext hash) to skip the
// upload entirely. Files that exist on the server are recorded hash-only.
// Remaining files are encrypted (unless opted out) and stored as pending blobs
// for outbox upload. The file is read exactly once: the bytes feed both the
// hash and (for encrypted files) the ciphertext, so large attachments do not
// peak memory twice.
export async function prepareFiles(
	pending: PendingFile[],
	token: string | undefined,
): Promise<PreparedFile[]> {
	const out: PreparedFile[] = [];

	const seenHashes = new Map<string, PreparedFile>();

	try {
		for (const pf of pending) {
			if (pf.file.size > MaxSendableFileSize) {
				emitNotification(
					i18n.t("error.fileTooLarge", { name: pf.originalName }),
				);
				throw new Error(`file ${pf.originalName} exceeds the upload limit`);
			}
			const clientId = crypto.randomUUID();
			// Single read of the file bytes for both hashing and encryption.
			const raw = new Uint8Array(await pf.file.arrayBuffer());
			const plaintextHash = await hashBytes(raw);
			const previous = seenHashes.get(plaintextHash);
			if (previous !== undefined) {
				// Two identical attachments (a screenshot pasted twice, a file
				// copied under another name) used to abort the whole batch.
				// Reuse the first occurrence's key/upload: one upload, one key,
				// two attachments that both decrypt.
				out.push({
					clientId,
					plaintextHash,
					fileKey: previous.fileKey,
					onServer: previous.onServer,
					duplicate: true,
					fileMeta: {
						mimeType: pf.mimeType,
						name: pf.originalName,
						size: pf.size,
					},
				});
				continue;
			}

			const fileMeta: FileMeta = {
				mimeType: pf.mimeType,
				name: pf.originalName,
				size: pf.size,
			};

			// Only an unencrypted file can skip the upload: its bytes on the server
			// are the bytes of the original file, so a stored copy is
			// interchangeable. An encrypted file uses a fresh key per upload, and
			// the stored ciphertext belongs to the key of the upload that created
			// it, so it is always uploaded again.
			if (pf.encrypted === false && token !== undefined) {
				try {
					if (await fileExistsByHash(token, plaintextHash)) {
						const prepared: PreparedFile = {
							clientId,
							plaintextHash,
							onServer: true,
							fileMeta,
						};
						out.push(prepared);
						seenHashes.set(plaintextHash, prepared);
						continue;
					}
				} catch {
					// On any error, fall through to upload the file.
				}
			}

			if (pf.encrypted === false) {
				// Unencrypted: store plaintext blob, no file key.
				await pendingBlobsRepo.put({
					id: clientId,
					blob: pf.file,
					name: pf.originalName,
					mimeType: pf.mimeType,
					size: pf.size,
					plaintextHash,
					encrypted: false,
				});
				const prepared: PreparedFile = { clientId, plaintextHash, fileMeta };
				out.push(prepared);
				seenHashes.set(plaintextHash, prepared);
				continue;
			}

			// Encrypted: generate file key, encrypt the already-read bytes, store
			// ciphertext.
			const fileKey = await generateFileKey();
			const ciphertext = await encryptBytes(raw, fileKey);

			await pendingBlobsRepo.put({
				id: clientId,
				blob: new Blob([ciphertext as unknown as ArrayBuffer]),
				// The server stores the multipart filename. For an encrypted
				// upload it must not learn the real name: the sender restores
				// it from fileMeta after decryption.
				name: "encrypted",
				mimeType: pf.mimeType,
				size: pf.size,
				plaintextHash,
				encrypted: true,
			});
			const prepared: PreparedFile = {
				clientId,
				fileKey,
				plaintextHash,
				fileMeta,
			};
			out.push(prepared);
			seenHashes.set(plaintextHash, prepared);
		}
	} catch (err) {
		// A late file (e.g. over the size limit) must not orphan the blobs
		// staged for the earlier files of the same batch.
		await dropPreparedBlobs(out);
		throw err;
	}

	return out;
}

// buildFileMaps indexes prepared files for encryption and upload:
// fileKeys/fileMeta by plaintext hash for the encrypted content, fileHashes
// for server-side dedup, uploadClientIds for the outbox.
export function buildFileMaps(prepared: PreparedFile[]): {
	fileKeys: Record<string, FileKey>;
	fileMeta: Record<string, FileMeta>;
	fileHashes: string[];
	uploadClientIds: string[];
} {
	const fileKeys: Record<string, FileKey> = {};
	const fileMeta: Record<string, FileMeta> = {};
	for (const p of prepared) {
		if (p.fileKey !== undefined) fileKeys[p.plaintextHash] = p.fileKey;
		if (p.fileMeta !== undefined) fileMeta[p.plaintextHash] = p.fileMeta;
	}
	return {
		fileKeys,
		fileMeta,
		fileHashes: prepared.filter((p) => p.onServer).map((p) => p.plaintextHash),
		uploadClientIds: prepared
			.filter((p) => !p.onServer && p.duplicate !== true)
			.map((p) => p.clientId),
	};
}

// dropPreparedBlobs deletes the staged blobs of prepared files that still
// need uploading (used when encryption is skipped or fails).
export async function dropPreparedBlobs(
	prepared: PreparedFile[],
): Promise<void> {
	const ids = prepared
		.filter((p) => !p.onServer && p.duplicate !== true)
		.map((p) => p.clientId);
	if (ids.length > 0) {
		await pendingBlobsRepo.deleteMany(ids);
	}
}
