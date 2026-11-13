import { type APIRequestContext, expect, test } from "@playwright/test";
import { BotClient } from "../../sdk/typescript/src/index.ts";

interface Account {
	token: string;
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
