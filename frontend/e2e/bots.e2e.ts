import { type APIRequestContext, expect, test } from "@playwright/test";
import { decryptBotMessage } from "../../sdk/typescript/src/crypto.ts";
import { BotClient } from "../../sdk/typescript/src/index.ts";

interface Account {
	token: string;
	sessionId?: string;
	user: { id: string; username: string; nick: string };
}

async function account(request: APIRequestContext): Promise<Account> {
	const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 5)}`;
	const email = `bot-${suffix}@e2e.local`;
	const sent = await request.post("/api/auth/send-code", { data: { email } });
	const { debugCode } = (await sent.json()) as { debugCode: string };
	const verified = await request.post("/api/auth/verify-code", {
		data: {
			email,
			code: debugCode,
			deviceId: "bot-e2e",
			deviceName: "Bot E2E",
		},
	});
	const answer = (await verified.json()) as { setupToken: string };
	const registered = await request.post("/api/auth/complete-registration", {
		data: {
			setupToken: answer.setupToken,
			username: `b${suffix}`.slice(0, 20),
			displayName: "Bot E2E User",
			deviceId: "bot-e2e",
			deviceName: "Bot E2E",
		},
	});
	expect(registered.ok()).toBeTruthy();
	return (await registered.json()) as Account;
}

test("bot API and TypeScript SDK exchange a message and a callback", async ({
	request,
}) => {
	const user = await account(request);
	const auth = { Authorization: `Bearer ${user.token}` };
	const created = await request.post("/api/bots", {
		headers: auth,
		data: {
			username: `e2e_${Date.now().toString(36)}_bot`,
			displayName: "E2E Bot",
		},
	});
	expect(created.ok()).toBeTruthy();
	const creation = (await created.json()) as {
		token: string;
		bot: { username: string };
	};

	const bot = new BotClient({
		token: creation.token,
		baseUrl: "http://localhost:8081",
	});
	expect((await bot.getMe()).username).toBe(creation.bot.username);

	const opened = await request.post("/api/bot-chats", {
		headers: auth,
		data: { username: creation.bot.username },
	});
	expect(opened.ok()).toBeTruthy();
	const chat = (await opened.json()) as { chat: { id: string } };

	const chatInfo = await bot.getChat(chat.chat.id);
	expect(chatInfo.id).toBe(chat.chat.id);
	expect(chatInfo.type).toBe("private");
	await bot.sendChatAction(chat.chat.id, "typing");
	const uploaded = await bot.uploadFile(
		new TextEncoder().encode("hello"),
		"hello.txt",
		"text/plain",
	);
	const fileMessage = await bot.sendFile(chat.chat.id, uploaded.id, "file");
	expect(fileMessage.files?.[0]?.originalName).toBe("hello.txt");
	const downloaded = await bot.downloadFile(uploaded.id);
	expect(new TextDecoder().decode(downloaded)).toBe("hello");
	const locationMessage = await bot.sendLocation(chat.chat.id, 55.75, 37.61);
	expect(locationMessage.location).toEqual({ lat: 55.75, lng: 37.61 });

	const sent = await request.post(`/api/chats/${chat.chat.id}/messages`, {
		headers: auth,
		data: { text: "ping" },
	});
	expect(sent.ok()).toBeTruthy();

	const updates = await bot.getUpdates({ offset: 0, timeout: 1 });
	const incoming = updates.find(
		(update) => update.message?.text === "ping",
	)?.message;
	if (incoming === undefined) throw new Error("SDK did not receive ping");

	const reply = await bot.sendMessage(incoming.chatId, "pong", {
		replyMarkup: {
			inlineKeyboard: [[{ text: "Yes", callbackData: "yes" }]],
		},
	});
	expect(reply.text).toBe("pong");

	const pressed = await request.post(
		`/api/bot-chats/${chat.chat.id}/callbacks`,
		{ headers: auth, data: { messageId: reply.messageId, data: "yes" } },
	);
	expect(pressed.ok()).toBeTruthy();

	const nextOffset = Math.max(...updates.map((update) => update.updateId)) + 1;
	const callbacks = await bot.getUpdates({ offset: nextOffset, timeout: 1 });
	const callback = callbacks.find(
		(update) => update.callbackQuery !== undefined,
	)?.callbackQuery;
	if (callback === undefined) throw new Error("SDK did not receive callback");
	expect(callback.data).toBe("yes");
	await bot.answerCallbackQuery(callback.id, "ok");
});

test("E2EE bot sends encrypted file and location", async ({ request }) => {
	const user = await account(request);
	const auth = { Authorization: `Bearer ${user.token}` };
	const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 5)}`;
	const created = await request.post("/api/bots", {
		headers: auth,
		data: { username: `e2ee_${suffix}_bot`, displayName: "E2EE Bot" },
	});
	expect(created.ok()).toBeTruthy();
	const creation = (await created.json()) as {
		token: string;
		bot: { id: string; username: string };
	};

	const sodium = (await import("libsodium-wrappers")).default;
	await sodium.ready;
	const userPair = sodium.crypto_box_keypair();
	const userKey = {
		publicKey: sodium.to_base64(userPair.publicKey),
		privateKey: sodium.to_base64(userPair.privateKey),
	};
	const registered = await request.put("/api/users/device-key", {
		headers: auth,
		data: { publicKey: userKey.publicKey },
	});
	expect(registered.ok()).toBeTruthy();

	const bot = new BotClient({
		token: creation.token,
		baseUrl: "http://localhost:8081",
	});
	const botKey = await bot.enableE2EE();
	expect(botKey.publicKey).not.toBe("");
	const opened = await request.post("/api/bot-chats", {
		headers: auth,
		data: { username: creation.bot.username },
	});
	const chat = (await opened.json()) as { chat: { id: string } };

	(bot as unknown as { chatUsers: Map<string, string> }).chatUsers.set(
		chat.chat.id,
		user.user.id,
	);
	const plaintext = new TextEncoder().encode("encrypted attachment");
	await bot.sendEncryptedFile(
		chat.chat.id,
		plaintext,
		"secret.txt",
		"text/plain",
	);
	await bot.sendMessage(chat.chat.id, "", {
		location: { lat: 55.75, lng: 37.61 },
	});

	const messagesResponse = await request.get(
		`/api/chats/${chat.chat.id}/messages?limit=10`,
		{ headers: auth },
	);
	const messages = (await messagesResponse.json()) as {
		messages: Array<{
			id: string;
			text: string;
			encrypted: boolean;
			encryptedPayload: string;
			files?: Array<{ id: string; hash: string; originalName: string }>;
		}>;
	};
	const fileMessage = messages.messages.find(
		(message) => message.files?.length,
	);
	const locationMessage = messages.messages.find(
		(message) => message.encrypted && !message.files?.length,
	);
	if (fileMessage === undefined || locationMessage === undefined)
		throw new Error("encrypted messages missing");
	const fileContent = await decryptBotMessage(
		fileMessage.text,
		fileMessage.encryptedPayload,
		user.sessionId ?? "bot-e2e",
		userKey,
	);
	const locationContent = await decryptBotMessage(
		locationMessage.text,
		locationMessage.encryptedPayload,
		user.sessionId ?? "bot-e2e",
		userKey,
	);
	expect(locationContent.location).toEqual({ lat: 55.75, lng: 37.61 });
	const file = fileMessage.files?.[0];
	if (file === undefined) throw new Error("file missing");
	const fileKey = fileContent.fileKeys?.[file.hash];
	if (fileKey === undefined) throw new Error("file key missing");
	const download = await request.get(`/api/files/${file.id}`, {
		headers: auth,
	});
	expect(download.ok()).toBeTruthy();
	const decrypted = await (
		await import("../../sdk/typescript/src/crypto.ts")
	).decryptFileBytes(new Uint8Array(await download.body()), fileKey);
	expect(new TextDecoder().decode(decrypted)).toBe("encrypted attachment");
});

test("root bot answers with buttons and handles its callback", async ({
	request,
}) => {
	const user = await account(request);
	const auth = { Authorization: `Bearer ${user.token}` };

	const opened = await request.post("/api/bot-chats", {
		headers: auth,
		data: { username: "root_bot" },
	});
	expect(opened.ok()).toBeTruthy();
	const chat = (await opened.json()) as { chat: { id: string } };

	const sent = await request.post(`/api/chats/${chat.chat.id}/messages`, {
		headers: auth,
		data: { text: "/start" },
	});
	expect(sent.ok()).toBeTruthy();

	const page = await request.get(`/api/chats/${chat.chat.id}/messages`, {
		headers: auth,
	});
	const { messages } = (await page.json()) as {
		messages: Array<{
			id: string;
			text: string;
			replyMarkup?: { inline_keyboard: Array<Array<{ text: string }>> };
		}>;
	};
	const greeting = [...messages]
		.reverse()
		.find((message) => message.replyMarkup !== undefined);
	if (greeting === undefined) throw new Error("root bot menu missing");
	expect(greeting.text).toContain("Root Bot");
	expect(greeting.text).not.toContain("Привет");
	expect(
		greeting.replyMarkup?.inline_keyboard.flat().map((button) => button.text),
	).toEqual(["Create a bot", "My bots", "Help"]);

	const pressed = await request.post(
		`/api/bot-chats/${chat.chat.id}/callbacks`,
		{
			headers: auth,
			data: { messageId: greeting.id, data: "root:newbot" },
		},
	);
	expect(pressed.ok()).toBeTruthy();

	const after = await request.get(`/api/chats/${chat.chat.id}/messages`, {
		headers: auth,
	});
	const { messages: updated } = (await after.json()) as {
		messages: Array<{ text: string }>;
	};
	expect(
		updated.some((message) =>
			message.text.includes("What should the bot be called"),
		),
	).toBe(true);
});
