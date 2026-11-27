import { describe, expect, it } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import type { Message } from "../types/api.ts";
import { messageAAD } from "./chat-encrypt.ts";
import {
	type EncryptedPayload,
	encryptContent,
	generateIdentityKeyPair,
	generateKeyPair,
	type IdentityKeyPair,
	type KeyPair,
	sealMessageKey,
	signSenderBinding,
} from "./crypto.ts";
import {
	decryptFileStream,
	encryptFileStream,
	generateFileKey,
} from "./file-crypto.ts";
import { decryptMessage } from "./message.ts";

interface Binding {
	chatId: string;
	messageId: string;
	fromId: string;
	threadId?: string;
}

async function encryptV3(
	text: string,
	sender: KeyPair,
	identity: IdentityKeyPair,
	binding: Binding,
	recipients: Array<{ keyId: string; publicKey: string; keyVersion: number }>,
): Promise<{ text: string; encryptedPayload: string }> {
	setActiveAccountKey("alice:test");
	const msgKey = crypto.getRandomValues(new Uint8Array(32));
	const aad = messageAAD(binding);
	const content = await encryptContent({ text }, msgKey, aad);
	const envelopes = await sealMessageKey(msgKey, recipients, sender);
	const payload: EncryptedPayload = {
		v: 3,
		nonce: content.nonce,
		senderKey: sender.publicKey,
		identityKey: identity.publicKey,
		identitySig: await signSenderBinding(identity, aad, sender.publicKey),
		envelopes,
	};
	return {
		text: content.ciphertext,
		encryptedPayload: JSON.stringify(payload),
	};
}

function message(
	binding: Binding,
	enc: { text: string; encryptedPayload: string },
): Message {
	return {
		id: binding.messageId,
		chatId: binding.chatId,
		threadId: binding.threadId,
		fromId: binding.fromId,
		fromNick: "alice",
		text: enc.text,
		encrypted: true,
		encryptedPayload: enc.encryptedPayload,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

describe("v3 message encryption", () => {
	it("lets every participant open its own envelope", async () => {
		const alice = await generateKeyPair();
		const bob = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m1", fromId: "alice:test" };
		const enc = await encryptV3("hello", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
			{ keyId: "bob:test", publicKey: bob.publicKey, keyVersion: 1 },
		]);

		expect(enc.text).not.toContain("hello");
		await expect(
			decryptMessage(message(binding, enc), "alice:test", alice),
		).resolves.toMatchObject({ text: "hello" });
		await expect(
			decryptMessage(
				{ ...message(binding, enc), fromId: "alice:test" },
				"bob:test",
				bob,
			),
		).resolves.toMatchObject({ text: "hello" });
	});

	it("marks a message addressed to nobody as undecryptable", async () => {
		const alice = await generateKeyPair();
		const eve = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m2", fromId: "alice:test" };
		const enc = await encryptV3("secret", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);

		const out = await decryptMessage(message(binding, enc), "eve:test", eve);
		expect(out.undecryptable).toBe(true);
	});

	it("rejects ciphertext moved to another message id", async () => {
		const alice = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = {
			chatId: "c1",
			messageId: "m-original",
			fromId: "alice:test",
		};
		const enc = await encryptV3("bound secret", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);

		const out = await decryptMessage(
			{ ...message(binding, enc), id: "m-moved" },
			"alice:test",
			alice,
		);
		expect(out.undecryptable).toBe(true);
	});

	it("falls back to the current key when the envelope version is ahead", async () => {
		setActiveAccountKey(`fallback-${Date.now()}:test`);
		const alice = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m-fb", fromId: "alice:test" };
		const enc = await encryptV3("still readable", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 2 },
		]);

		const out = await decryptMessage(
			message(binding, enc),
			"alice:test",
			alice,
		);
		expect(out.text).toBe("still readable");
	});

	it("pins the sender identity and rejects a silent change", async () => {
		setActiveAccountKey(`pinning-${Date.now()}:test`);
		const alice = await generateKeyPair();
		const bob = await generateKeyPair();
		const firstIdentity = await generateIdentityKeyPair();
		const secondIdentity = await generateIdentityKeyPair();
		const first = await encryptV3(
			"first",
			bob,
			firstIdentity,
			{ chatId: "c1", messageId: "p1", fromId: "bob:test" },
			[{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 }],
		);
		await expect(
			decryptMessage(
				message({ chatId: "c1", messageId: "p1", fromId: "bob:test" }, first),
				"alice:test",
				alice,
			),
		).resolves.toMatchObject({ text: "first" });

		const changed = await encryptV3(
			"changed",
			bob,
			secondIdentity,
			{ chatId: "c1", messageId: "p2", fromId: "bob:test" },
			[{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 }],
		);
		const out = await decryptMessage(
			message({ chatId: "c1", messageId: "p2", fromId: "bob:test" }, changed),
			"alice:test",
			alice,
		);
		expect(out.undecryptable).toBe(true);
	});

	it("decrypts a stored message and resolves its reply preview", async () => {
		setActiveAccountKey("alice:test");
		const alice = await generateKeyPair();
		const bob = await generateKeyPair();
		const aliceIdentity = await generateIdentityKeyPair();
		const bobIdentity = await generateIdentityKeyPair();

		const parentBinding = {
			chatId: "c1",
			messageId: "parent-1",
			fromId: "bob:test",
		};
		const parent = await encryptV3(
			"parent secret",
			bob,
			bobIdentity,
			parentBinding,
			[{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 }],
		);
		await messagesRepo.upsertMany([message(parentBinding, parent)]);

		const childBinding = {
			chatId: "c1",
			messageId: "child-1",
			fromId: "alice:test",
		};
		const child = await encryptV3("child", alice, aliceIdentity, childBinding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);

		const out = await decryptMessage(
			{
				...message(childBinding, child),
				replyTo: { messageId: "parent-1", fromNick: "bob", text: "" },
			},
			"alice:test",
			alice,
		);
		expect(out.text).toBe("child");
		expect(out.replyTo?.text).toBe("parent secret");
	});

	it("passes plaintext messages through untouched", async () => {
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

	it("shows a placeholder when the private key is unavailable", async () => {
		const alice = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m3", fromId: "alice:test" };
		const enc = await encryptV3("top secret", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);

		const out = await decryptMessage(message(binding, enc), "alice:test", null);
		expect(out.undecryptable).toBe(true);
		expect(out.text).not.toContain("top secret");
	});

	it("does not expose server-controlled fields before decryption", async () => {
		const alice = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m4", fromId: "alice:test" };
		const enc = await encryptV3("data", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);
		const out = await decryptMessage(
			{
				...message(binding, enc),
				files: [
					{
						id: "f1",
						mimeType: "image/png",
						size: 1,
						originalName: "x",
						fileType: "file",
						url: "/api/files/f1",
					},
				],
				location: { lat: 1, lng: 2 },
			},
			"alice:test",
			alice,
		);
		expect(out.files).toBeUndefined();
	});
});

describe("messagesRepo stores ciphertext verbatim", () => {
	it("never exposes plaintext through the repo", async () => {
		setActiveAccountKey("alice:test");
		const alice = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		const binding = { chatId: "c1", messageId: "m5", fromId: "alice:test" };
		const enc = await encryptV3("secret text", alice, identity, binding, [
			{ keyId: "alice:test", publicKey: alice.publicKey, keyVersion: 1 },
		]);
		await messagesRepo.upsertMany([message(binding, enc)]);
		const stored = await messagesRepo.getById("c1", "m5");
		expect(stored?.text).not.toContain("secret text");
	});
});

describe("File encryption", () => {
	it("encrypts and decrypts a file roundtrip", async () => {
		const key = await generateFileKey();
		const plain = new Uint8Array([1, 2, 3, 4, 5]);
		const encrypted = await encryptFileStream(new Blob([plain]), key);
		const decrypted = await decryptFileStream(encrypted, key);
		expect([...decrypted]).toEqual([...plain]);
	});

	it("generates unique file keys", async () => {
		const a = await generateFileKey();
		const b = await generateFileKey();
		expect(a.key).not.toBe(b.key);
	});
});
