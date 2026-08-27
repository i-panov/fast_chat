import { describe, expect, it } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { Message } from "../types/api.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";
import {
	decryptMessage,
	decryptMessageText,
	encryptMessageText,
} from "./message.ts";

async function keyPair(): Promise<KeyPair> {
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
