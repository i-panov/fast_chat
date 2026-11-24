import assert from "node:assert/strict";
import { test } from "node:test";
import {
	decryptBotMessage,
	decryptCallbackData,
	encryptBotReply,
	encryptCallbackData,
	generateEncryptionKeyPair,
} from "../src/crypto.js";

test("encrypted bot reply can be opened by the device key", async () => {
	const key = await generateEncryptionKeyPair();
	const encrypted = await encryptBotReply("secret", [
		{ id: "user:test", publicKey: key.publicKey },
	]);
	const opened = await decryptBotMessage(
		encrypted.text,
		encrypted.payload,
		"user:test",
		key,
	);
	assert.equal(opened.text, "secret");
});

test("encrypted buttons and callback data round-trip", async () => {
	const bot = await generateEncryptionKeyPair();
	const user = await generateEncryptionKeyPair();
	const callback = await encryptCallbackData("yes", bot.publicKey);
	const encrypted = await encryptBotReply(
		"choose",
		[{ id: "user:test", publicKey: user.publicKey }],
		[[{ text: "Yes", callbackData: callback }]],
	);
	const opened = await decryptBotMessage(
		encrypted.text,
		encrypted.payload,
		"user:test",
		user,
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
