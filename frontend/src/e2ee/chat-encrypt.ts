import sodium from "libsodium-wrappers";
import { fileExistsByHash } from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import i18n from "../i18n.ts";
import type { Location, PendingFile } from "../types/api.ts";
import { emitNotification } from "../utils/notify.ts";
import {
	encryptContent,
	ensureSodium,
	type FileMeta,
	sealMessageKey,
} from "./crypto.ts";
import type { FileKey } from "./file-crypto.ts";
import { encryptBytes, generateFileKey, hashBytes } from "./file-crypto.ts";
import {
	ensureAccountKeys,
	getRecipientPublicKeys,
	RecoveryRequiredError,
} from "./keys.ts";

export interface EncryptResult {
	ciphertext: string;
	nonce: string;
	envelopes: Array<{ keyId: string; box: string }>;
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
): Promise<EncryptResult | null> {
	try {
		const chat = await chatsRepo.getById(chatId);
		if (chat === undefined || token === undefined) return null;

		const memberIds = chat.members.map((m) => m.id);
		if (memberIds.length === 0) {
			throw new Error("chat has no members");
		}
		await ensureAccountKeys(token);

		const recipientKeys = await getRecipientPublicKeys(token, memberIds);
		const recipients: Array<{ keyId: string; publicKey: string }> = [];
		const missing: string[] = [];

		for (const id of memberIds) {
			const publicKey = recipientKeys.get(id);
			if (publicKey && publicKey !== "") {
				recipients.push({ keyId: id, publicKey });
			} else {
				missing.push(id);
			}
		}

		if (recipients.length === 0) {
			throw new Error("no recipient keys available");
		}

		if (missing.length > 0) {
			const nicks = chat.members
				.filter((m) => missing.includes(m.id))
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
		const encrypted = await encryptContent(contentBlob, msgKey);
		const envelopes = await sealMessageKey(msgKey, recipients);

		return {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			envelopes: envelopes.map((e) => ({ keyId: e.keyId, box: e.box })),
		};
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
						out.push({ clientId, plaintextHash, onServer: true, fileMeta });
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
				out.push({ clientId, plaintextHash, fileMeta });
				continue;
			}

			// Encrypted: generate file key, encrypt the already-read bytes, store
			// ciphertext.
			const fileKey = await generateFileKey();
			const ciphertext = await encryptBytes(raw, fileKey);

			await pendingBlobsRepo.put({
				id: clientId,
				blob: new Blob([ciphertext as unknown as ArrayBuffer]),
				name: pf.originalName,
				mimeType: pf.mimeType,
				size: pf.size,
				plaintextHash,
				encrypted: true,
			});
			out.push({ clientId, fileKey, plaintextHash });
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
		uploadClientIds: prepared.filter((p) => !p.onServer).map((p) => p.clientId),
	};
}

// dropPreparedBlobs deletes the staged blobs of prepared files that still
// need uploading (used when encryption is skipped or fails).
export async function dropPreparedBlobs(
	prepared: PreparedFile[],
): Promise<void> {
	const ids = prepared.filter((p) => !p.onServer).map((p) => p.clientId);
	if (ids.length > 0) {
		await pendingBlobsRepo.deleteMany(ids);
	}
}
