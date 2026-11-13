import assert from "node:assert/strict";
import { test } from "node:test";
import { decryptBotMessage, encryptBotReply, generateEncryptionKeyPair } from "../src/crypto.js";

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
