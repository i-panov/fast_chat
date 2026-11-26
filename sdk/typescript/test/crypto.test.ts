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

test("v2 message with identity signature is decrypted", async () => {
	const sodium = (await import("libsodium-wrappers")).default;
	await sodium.ready;
	const bot = await generateEncryptionKeyPair();
	const sender = await generateEncryptionKeyPair();
	const identity = sodium.crypto_sign_keypair();

	const binding = {
		chatId: "chat-1",
		messageId: "m-1",
		fromId: "user:test",
	};
	const aad = `chat-1|m-1|user:test|`;
	const nonce = sodium.randombytes_buf(24);
	const msgKey = sodium.randombytes_buf(32);
	const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
		new TextEncoder().encode(JSON.stringify({ text: "v2 secret" })),
		new TextEncoder().encode(aad),
		null,
		nonce,
		msgKey,
	);
	const box = sodium.crypto_box_easy(
		msgKey,
		nonce,
		sodium.from_base64(bot.publicKey),
		sodium.from_base64(sender.privateKey),
	);
	const payload = JSON.stringify({
		v: 2,
		nonce: sodium.to_base64(nonce),
		senderKey: sender.publicKey,
		identityKey: sodium.to_base64(identity.publicKey),
		identitySig: sodium.to_base64(
			sodium.crypto_sign_detached(
				new TextEncoder().encode(`${aad}|${sender.publicKey}`),
				identity.privateKey,
			),
		),
		envelopes: [
			{ keyId: "user:test", box: sodium.to_base64(box), nonce: sodium.to_base64(nonce) },
		],
	});

	const opened = await decryptBotMessage(
		sodium.to_base64(ciphertext),
		payload,
		"user:test",
		bot,
		binding,
	);
	assert.equal(opened.text, "v2 secret");

	await assert.rejects(() =>
		decryptBotMessage(
			sodium.to_base64(ciphertext),
			payload,
			"user:test",
			bot,
			{ ...binding, chatId: "chat-other" },
		),
	);
});
