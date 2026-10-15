import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import type { Message } from "../types/api.ts";
import { type EncryptResult, encryptForChat } from "./chat-encrypt.ts";
import { generateKeyPair, type KeyPair } from "./crypto.ts";
import {
	decryptFileStream,
	encryptFileStream,
	generateFileKey,
} from "./file-crypto.ts";
import { decryptMessage } from "./message.ts";

// Mutable holder for the keys generated per test. vi.mock factories are
// hoisted, so plain top-level variables cannot be referenced there —
// vi.hoisted is the supported indirection.
const keyStore = vi.hoisted(() => ({
	alice: null as KeyPair | null,
	bob: null as KeyPair | null,
}));

// The api module is mocked so encryption runs without a network: recipient
// public keys resolve to the per-test key pairs, and the key-backup lookup
// reports "no backup" so ensureAccountKeys generates fresh local keys.
vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn((_token: string, userId: string) => {
		if (userId === "alice:test" && keyStore.alice !== null) {
			return { publicKey: keyStore.alice.publicKey, keyVersion: "v" };
		}
		if (userId === "bob:test" && keyStore.bob !== null) {
			return { publicKey: keyStore.bob.publicKey, keyVersion: "v" };
		}
		return { publicKey: "", keyVersion: "" };
	}),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
}));

function toMessage(id: string, encrypted: EncryptResult): Message {
	return {
		id,
		chatId: "chat-v2",
		fromId: "alice:test",
		fromNick: "alice",
		text: encrypted.ciphertext,
		encrypted: true,
		encryptedPayload: JSON.stringify({
			v: 1,
			nonce: encrypted.nonce,
			envelopes: encrypted.envelopes,
		}),
		createdAt: "2026-01-01T00:00:00Z",
	};
}

describe("encryptForChat → decryptMessage roundtrip (v2 content format)", () => {
	beforeEach(async () => {
		setActiveAccountKey("alice:test");
		keyStore.alice = await generateKeyPair();
		keyStore.bob = await generateKeyPair();

		await chatsRepo.upsert({
			id: "chat-v2",
			type: "group",
			name: "v2",
			ownerId: "alice:test",
			members: [
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			],
			createdAt: "2026-01-01T00:00:00Z",
		});
	});

	it("round-trips text + location + file keys to another recipient", async () => {
		const fileKey = await generateFileKey();
		const fileKeys = { "hash-1": fileKey };

		const encrypted = await encryptForChat(
			"token",
			"chat-v2",
			{ text: "hello v2", location: { lat: 10, lng: 20 } },
			fileKeys,
		);

		if (encrypted === null) throw new Error("encryptForChat returned null");
		expect(encrypted.ciphertext).not.toContain("hello v2");

		const out = await decryptMessage(
			toMessage("m-v2", encrypted),
			"bob:test",
			keyStore.bob,
		);

		expect(out.text).toBe("hello v2");
		expect(out.location).toEqual({ lat: 10, lng: 20 });
		expect(out.fileKeys).toEqual(fileKeys);
	});

	it("decrypts a file with the key recovered from the message", async () => {
		const original = new Blob(["v2 file content"], { type: "text/plain" });
		const fileKey = await generateFileKey();
		const ciphertext = await encryptFileStream(original, fileKey);

		const encrypted = await encryptForChat(
			"token",
			"chat-v2",
			{ text: "with file" },
			{ "plaintext-hash": fileKey },
		);
		if (encrypted === null) throw new Error("encryptForChat returned null");

		const out = await decryptMessage(
			toMessage("m-v2-file", encrypted),
			"bob:test",
			keyStore.bob,
		);

		expect(out.text).toBe("with file");
		const lookedUp = out.fileKeys?.["plaintext-hash"];
		expect(lookedUp).toEqual(fileKey);

		const plain = await decryptFileStream(
			ciphertext,
			lookedUp ?? { nonce: "", key: "" },
		);
		expect(new TextDecoder().decode(plain)).toBe("v2 file content");
	});

	it("round-trips text-only content (no location, plaintext files)", async () => {
		const encrypted = await encryptForChat(
			"token",
			"chat-v2",
			{ text: "just text" },
			{},
		);
		if (encrypted === null) throw new Error("encryptForChat returned null");

		const out = await decryptMessage(
			toMessage("m-v2-text", encrypted),
			"alice:test",
			keyStore.alice,
		);

		expect(out.text).toBe("just text");
		expect(out.location).toBeUndefined();
		expect(out.fileKeys).toEqual({});
	});
});
