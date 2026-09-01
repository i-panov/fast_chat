import { describe, expect, it } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { Message } from "../types/api.ts";
import {
	decryptContent,
	encryptContent,
	generateKeyPair,
	type KeyPair,
} from "./crypto.ts";
import {
	computePlaintextHash,
	decryptFileStream,
	encryptFileStream,
	generateFileKey,
	type FileKey,
} from "./file-crypto.ts";
import {
	decryptMessage,
	decryptMessageText,
	encryptMessageText,
} from "./message.ts";

const HEX_HASH_REGEX = /^[0-9a-f]{64}$/; // SHA-256 = 32 bytes = 64 hex chars

function keyPair(): Promise<KeyPair> {
	return generateKeyPair();
}

describe("E2E crypto roundtrip", () => {
	it("encrypts to multiple recipients and only they can decrypt", async () => {
		const alice = await keyPair();
		const bob = await keyPair();
		const eve = await keyPair();

		const { text, encryptedPayload } = await encryptMessageText(
			"hello secret",
			[
				{ keyId: "alice:test", publicKey: alice.publicKey },
				{ keyId: "bob:test", publicKey: bob.publicKey },
			],
		);

		expect(text).not.toContain("hello secret");
		expect(encryptedPayload).toContain("alice:test");
		expect(encryptedPayload).toContain("bob:test");

		const msg = { text, encryptedPayload };

		await expect(decryptMessageText(msg, "alice:test", alice)).resolves.toBe(
			"hello secret",
		);
		await expect(decryptMessageText(msg, "bob:test", bob)).resolves.toBe(
			"hello secret",
		);

		// Eve has no envelope: she must not be able to decrypt.
		await expect(decryptMessageText(msg, "eve:test", eve)).rejects.toThrow();
	});

	it("produces a different ciphertext for identical plaintext", async () => {
		const alice = await keyPair();
		const a = await encryptMessageText("same", [
			{ keyId: "a:test", publicKey: alice.publicKey },
		]);
		const b = await encryptMessageText("same", [
			{ keyId: "a:test", publicKey: alice.publicKey },
		]);

		expect(a.text).not.toBe(b.text);
		expect(a.encryptedPayload).not.toBe(b.encryptedPayload);
	});
});

describe("decryptMessage", () => {
	it("passes legacy plaintext messages through untouched", async () => {
		const msg: Message = {
			id: "m1",
			chatId: "c1",
			fromId: "a:test",
			fromNick: "a",
			text: "plain",
			createdAt: "2026-01-01T00:00:00Z",
		};

		const out = await decryptMessage(msg, "a:test", null);
		expect(out.text).toBe("plain");
	});

	it("decrypts a stored message and resolves the reply preview", async () => {
		setActiveAccountKey("alice:test");
		const alice = await keyPair();
		const bob = await keyPair();

		const parentEnc = await encryptMessageText("parent secret", [
			{ keyId: "alice:test", publicKey: alice.publicKey },
			{ keyId: "bob:test", publicKey: bob.publicKey },
		]);

		// The parent is stored as the server would store it (ciphertext).
		await messagesRepo.upsertMany([
			{
				id: "parent-1",
				chatId: "c1",
				fromId: "bob:test",
				fromNick: "bob",
				text: parentEnc.text,
				encrypted: true,
				encryptedPayload: parentEnc.encryptedPayload,
				createdAt: "2026-01-01T00:00:00Z",
			},
		]);

		const childEnc = await encryptMessageText("child", [
			{ keyId: "alice:test", publicKey: alice.publicKey },
		]);

		const child: Message = {
			id: "child-1",
			chatId: "c1",
			fromId: "alice:test",
			fromNick: "alice",
			text: childEnc.text,
			encrypted: true,
			encryptedPayload: childEnc.encryptedPayload,
			createdAt: "2026-01-01T00:00:01Z",
			replyTo: { messageId: "parent-1", text: parentEnc.text, fromNick: "bob" },
		};

		const out = await decryptMessage(child, "alice:test", alice);
		expect(out.text).toBe("child");
		expect(out.replyTo?.text).toBe("parent secret");
	});

	it("shows a placeholder when the private key is unavailable", async () => {
		const alice = await keyPair();
		const enc = await encryptMessageText("top secret", [
			{ keyId: "alice:test", publicKey: alice.publicKey },
		]);

		const msg: Message = {
			id: "m2",
			chatId: "c1",
			fromId: "bob:test",
			fromNick: "bob",
			text: enc.text,
			encrypted: true,
			encryptedPayload: enc.encryptedPayload,
			createdAt: "2026-01-01T00:00:00Z",
		};

		const out = await decryptMessage(msg, "alice:test", null);
		expect(out.text).not.toBe("top secret");
	});
});

describe("messagesRepo stores ciphertext verbatim", () => {
	it("never exposes plaintext through the repo", async () => {
		setActiveAccountKey("alice:test");
		const alice = await keyPair();
		const enc = await encryptMessageText("secret text", [
			{ keyId: "alice:test", publicKey: alice.publicKey },
		]);

		await messagesRepo.upsertMany([
			{
				id: "m3",
				chatId: "c1",
				fromId: "a:test",
				fromNick: "a",
				text: enc.text,
				encrypted: true,
				encryptedPayload: enc.encryptedPayload,
				createdAt: "2026-01-01T00:00:00Z",
			},
		]);

		const stored = await messagesRepo.getByChat("c1");
		expect(stored[0].text).toBe(enc.text);
		expect(stored[0].text).not.toContain("secret text");
	});
});

describe("MessageContent encryption (text + location)", () => {
	it("encrypts and decrypts text with location and file keys", async () => {
		const key1 = await generateFileKey();
		const key2 = await generateFileKey();
		const content = {
			text: "with files",
			location: { lat: 10, lng: 20 },
			fileKeys: { "file-1": key1, "file-2": key2 },
		};

		const msgKey = crypto.getRandomValues(new Uint8Array(32));
		const encrypted = await encryptContent(content, msgKey);

		expect(encrypted.ciphertext).not.toContain("with files");

		const decrypted = await decryptContent(encrypted, msgKey);
		expect(decrypted.text).toBe("with files");
		expect(decrypted.location).toEqual({ lat: 10, lng: 20 });
		expect(decrypted.fileKeys).toEqual({ "file-1": key1, "file-2": key2 });
	});

	it("handles missing file keys (plaintext files)", async () => {
		const content = {
			text: "no encrypted files",
			fileKeys: {},
		};

		const msgKey = crypto.getRandomValues(new Uint8Array(32));
		const encrypted = await encryptContent(content, msgKey);
		const decrypted = await decryptContent(encrypted, msgKey);

		expect(decrypted.text).toBe("no encrypted files");
		expect(decrypted.fileKeys).toEqual({});
	});

	it("produces different ciphertext for identical content", async () => {
		const content = { text: "same", location: { lat: 1, lng: 2 } };
		const key1 = crypto.getRandomValues(new Uint8Array(32));
		const key2 = crypto.getRandomValues(new Uint8Array(32));
		const a = await encryptContent(content, key1);
		const b = await encryptContent(content, key2);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});
});

describe("File encryption", () => {
	it("encrypts and decrypts a file roundtrip", async () => {
		const original = new Blob(["hello file world"], { type: "text/plain" });
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(original, fileKey);

		expect(new TextDecoder().decode(ciphertext)).not.toContain(
			"hello file world",
		);

		const plain = await decryptFileStream(ciphertext, fileKey);
		expect(new TextDecoder().decode(plain)).toBe("hello file world");
	});

	it("produces a stable plaintext hash", async () => {
		const blob = new Blob(["consistent content"], { type: "text/plain" });
		const hash1 = await computePlaintextHash(blob);
		const hash2 = await computePlaintextHash(blob);
		expect(hash1).toBe(hash2);
		expect(hash1).toMatch(HEX_HASH_REGEX);
	});

	it("generates unique file keys", async () => {
		const k1 = await generateFileKey();
		const k2 = await generateFileKey();
		expect(k1.key).not.toBe(k2.key);
		expect(k1.nonce).not.toBe(k2.nonce);
	});

	// Regression: keys are indexed by plaintext hash, not file ID. This
	// ensures the receiver (who gets different file IDs from the server) can
	// still look up the correct key.
	it("keys are indexed by hash for cross-client lookup", async () => {
		const original = new Blob(["shared content"], { type: "text/plain" });
		const fileKey = await generateFileKey();
		const hash = await computePlaintextHash(original);

		// Sender indexes key by hash.
		const keyStore: Record<string, FileKey> = { [hash]: fileKey };

	// Receiver gets a different file ID from the server but the same hash.
	const serverFileId = "server-assigned-id-123";
	// Key is NOT accessible by server-assigned ID (different from sender's ID).
	expect(keyStore[serverFileId]).toBeUndefined();
	// Key IS accessible by hash (same for sender and receiver).
	const lookedUpKey = keyStore[hash];

	expect(lookedUpKey).toBe(fileKey);

		// Encrypt and decrypt with the looked-up key.
		const ciphertext = await encryptFileStream(original, fileKey);
		const plain = await decryptFileStream(ciphertext, lookedUpKey);
		expect(new TextDecoder().decode(plain)).toBe("shared content");
	});
});
