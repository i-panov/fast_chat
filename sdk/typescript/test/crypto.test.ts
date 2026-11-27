import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decryptBotMessage,
	decryptCallbackData,
	encryptBotReply,
	encryptCallbackData,
	generateEncryptionKeyPair,
	generateSigningKeyPair,
} from "../src/crypto.js";

const BINDING = { chatId: "chat-1", messageId: "m-1", fromId: "bot:test" };

async function encryptedReply(text: string) {
	const bot = await generateEncryptionKeyPair();
	const identity = await generateSigningKeyPair();
	const user = await generateEncryptionKeyPair();
	const encrypted = await encryptBotReply(
		text,
		[{ id: "user:test", publicKey: user.publicKey, keyVersion: 1 }],
		undefined,
		undefined,
		{ binding: BINDING, encryptionKey: bot, identityKey: identity },
	);
	return { encrypted, user };
}

test("encrypted bot reply can be opened by the user's master key", async () => {
	const { encrypted, user } = await encryptedReply("secret");
	const opened = await decryptBotMessage(
		encrypted.text,
		encrypted.payload,
		"user:test",
		user,
		BINDING,
	);
	assert.equal(opened.text, "secret");
});

test("a moved message fails the binding check", async () => {
	const { encrypted, user } = await encryptedReply("secret");
	await assert.rejects(() =>
		decryptBotMessage(
			encrypted.text,
			encrypted.payload,
			"user:test",
			user,
			{ ...BINDING, chatId: "chat-other" },
		),
	);
});

test("encrypted buttons and callback data round-trip", async () => {
	const bot = await generateEncryptionKeyPair();
	const identity = await generateSigningKeyPair();
	const user = await generateEncryptionKeyPair();
	const callback = await encryptCallbackData("yes", bot.publicKey);
	const encrypted = await encryptBotReply(
		"choose",
		[{ id: "user:test", publicKey: user.publicKey, keyVersion: 1 }],
		[[{ text: "Yes", callbackData: callback }]],
		undefined,
		{ binding: BINDING, encryptionKey: bot, identityKey: identity },
	);
	const opened = await decryptBotMessage(
		encrypted.text,
		encrypted.payload,
		"user:test",
		user,
		BINDING,
	);
	assert.equal(opened.text, "choose");
	assert.deepEqual(opened.replyMarkup, {
		inline_keyboard: [[{ text: "Yes", callback_data: callback }]],
	});
	assert.equal(await decryptCallbackData(callback, bot), "yes");
});

test("file bytes round-trip", async () => {
	const {
		decryptFileBytes,
		encryptFileBytes,
		generateFileKey,
	} = await import("../src/index.js");
	const key = await generateFileKey();
	const plaintext = new TextEncoder().encode("attachment bytes");
	const encrypted = await encryptFileBytes(plaintext, key);
	assert.notDeepEqual(encrypted, plaintext);
	assert.deepEqual(await decryptFileBytes(encrypted, key), plaintext);
});
