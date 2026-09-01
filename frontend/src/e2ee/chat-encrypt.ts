import sodium from "libsodium-wrappers";
import { chatsRepo } from "../db/chatsRepo.ts";
import i18n from "../i18n.ts";
import type { Location } from "../types/api.ts";
import { emitNotification } from "../utils/notify.ts";
import { encryptContent, sealMessageKey } from "./crypto.ts";
import type { FileKey } from "./file-crypto.ts";
import { ensureAccountKeys, getRecipientPublicKeys } from "./keys.ts";

export interface EncryptResult {
	ciphertext: string;
	nonce: string;
	envelopes: Array<{ keyId: string; box: string }>;
}

// encryptForChat encrypts the full message content (text, location, file keys)
// to every recipient's public key. The file keys are included in the encrypted
// blob so only recipients can decrypt both the content and the files.
export async function encryptForChat(
	token: string | undefined,
	chatId: string,
	content: { text: string; location?: Location },
	fileKeys: Record<string, FileKey>,
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

		const msgKey = sodium.randombytes_buf(
			sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES,
		);
		const contentBlob = {
			text: content.text,
			location: content.location,
			fileKeys,
		};
		const encrypted = await encryptContent(contentBlob, msgKey);
		const envelopes = await sealMessageKey(msgKey, recipients);

		return {
			ciphertext: encrypted.ciphertext,
			nonce: encrypted.nonce,
			envelopes: envelopes.map((e) => ({ keyId: e.keyId, box: e.box })),
		};
	} catch {
		emitNotification(i18n.t("error.encryptionKeyMissing"));
		return null;
	}
}
