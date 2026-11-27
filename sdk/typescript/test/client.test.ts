import assert from "node:assert/strict";
import { test } from "node:test";
import { BotApiError, BotClient } from "../src/index.js";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

const me = {
	id: "weather_bot:example.test",
	username: "weather_bot",
	display_name: "Погода",
	is_bot: true,
};

test("getMe maps the bot profile", async () => {
	const client = new BotClient({
		mode: "server",
		token: "t",
		baseUrl: "https://chat.test",
		fetch: async () => jsonResponse({ ok: true, result: me }),
	});
	const user = await client.getMe();
	assert.equal(user.username, "weather_bot");
	assert.equal(user.displayName, "Погода");
});

test("sendMessage uses the Bot API envelope and snake_case body", async () => {
	let body: unknown;
	const client = new BotClient({
		mode: "server",
		token: "t",
		baseUrl: "https://chat.test",
		fetch: async (_url, init) => {
			body = JSON.parse(String(init?.body));
			return jsonResponse({
				ok: true,
				result: {
					message_id: "m1",
					chat_id: "c1",
					from: me,
					text: "hi",
					date: "2026-11-13T00:00:00Z",
				},
			});
		},
	});
	const message = await client.sendMessage("c1", "hi", {
		replyMarkup: {
			inlineKeyboard: [[{ text: "Да", callbackData: "yes" }]],
		},
	});
	assert.equal(message.messageId, "m1");
	assert.deepEqual(body, {
		chat_id: "c1",
		text: "hi",
		reply_markup: { inline_keyboard: [[{ text: "Да", callback_data: "yes" }]] },
	});
});

test("getUpdates maps message and callback query", async () => {
	const client = new BotClient({
		mode: "server",
		token: "t",
		fetch: async () =>
			jsonResponse({
				ok: true,
				result: [
					{
						update_id: 7,
						message: {
							message_id: "m1",
							chat_id: "c1",
							from: me,
							text: "hi",
							date: "2026-11-13T00:00:00Z",
						},
					},
					{
						update_id: 8,
						callback_query: {
							id: "cb1",
							from: me,
							message_id: "m1",
							chat_id: "c1",
							data: "yes",
						},
					},
				],
			}),
	});
	const updates = await client.getUpdates({ offset: 7 });
	assert.equal(updates[0]?.message?.text, "hi");
	assert.equal(updates[1]?.callbackQuery?.data, "yes");
});

test("API errors become BotApiError", async () => {
	const client = new BotClient({
		mode: "server",
		token: "t",
		fetch: async () =>
			jsonResponse(
				{ ok: false, error_code: 401, description: "invalid bot token" },
				401,
			),
	});
	await assert.rejects(client.getMe(), (error: unknown) => {
		assert.ok(error instanceof BotApiError);
		assert.equal((error as BotApiError).status, 401);
		return true;
	});
});

test("answerCallbackQuery accepts the ok envelope", async () => {
	let called = false;
	const client = new BotClient({
		mode: "server",
		token: "t",
		fetch: async () => {
			called = true;
			return jsonResponse({ ok: true, result: true });
		},
	});
	await client.answerCallbackQuery("cb1", "ok");
	assert.equal(called, true);
});

test("editMessageText and deleteMessage hit their endpoints", async () => {
	const paths: string[] = [];
	const client = new BotClient({
		mode: "server",
		token: "t",
		fetch: async (url) => {
			paths.push(new URL(String(url)).pathname);
			return jsonResponse({
				ok: true,
				result: {
					message_id: "m1",
					chat_id: "c1",
					from: me,
					text: "edited",
					date: "2026-11-13T00:00:00Z",
				},
			});
		},
	});
	await client.editMessageText("c1", "m1", "edited");
	await client.deleteMessage("c1", "m1");
	assert.deepEqual(paths, [
		"/api/bot-api/editMessageText",
		"/api/bot-api/deleteMessage",
	]);
});



test("getUserDeviceKeys accepts the server array shape", async () => {
	const client = new BotClient({
		mode: "server",
		token: "t",
		fetch: async () =>
			jsonResponse({
				ok: true,
				result: [{ id: "u1", publicKey: "cHVibGlj" }],
			}),
	});
	const keys = await client.getUserDeviceKeys("u1");
	assert.deepEqual(keys, [{ id: "u1", publicKey: "cHVibGlj", keyVersion: 1 }]);
});

test("sendEncryptedFile attaches the uploaded file", async () => {
	const { generateEncryptionKeyPair, generateSigningKeyPair } = await import(
		"../src/crypto.js"
	);
	const botKey = await generateEncryptionKeyPair();
	const botIdentity = await generateSigningKeyPair();
	const userKey = await generateEncryptionKeyPair();
	let sent: Record<string, unknown> | undefined;
	const client = new BotClient({
		token: "t",
		mode: "e2ee",
		encryptionKey: botKey,
		identityKey: botIdentity,
		fetch: async (url, init) => {
			const path = new URL(String(url)).pathname;
			if (path === "/api/bot-api/getMe") {
				return jsonResponse({ ok: true, result: { id: "bot:test", username: "b", display_name: "B", is_bot: true, encryption_mode: "e2ee" } });
			}
			if (path === "/api/bot-api/getUserDeviceKeys") {
				return jsonResponse({ ok: true, result: [{ id: "user:test", publicKey: userKey.publicKey, keyVersion: 1 }] });
			}
			if (path === "/api/bot-api/uploadFile") {
				return jsonResponse({ file: { id: "f1", mimeType: "text/plain", size: 1, originalName: "a.txt" } });
			}
			if (path === "/api/bot-api/sendMessage") {
				sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return jsonResponse({ ok: true, result: { message_id: "m1", chat_id: "c1", from: { id: "bot:test", username: "b", display_name: "B", is_bot: true }, text: "x", date: "2026-01-01" } });
			}
			throw new Error(path);
		},
	});
	(client as unknown as { chatUsers: Map<string, string> }).chatUsers.set("c1", "user:test");
	await client.sendEncryptedFile("c1", new Uint8Array([1, 2, 3]), "a.txt", "text/plain");
	assert.deepEqual((sent?.files as Array<{ id: string }>)[0], { id: "f1" });
});
