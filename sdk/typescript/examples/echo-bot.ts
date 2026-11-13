import { BotClient } from "../src/index.js";

const token = process.env.FASTCHAT_BOT_TOKEN;
if (token === undefined) throw new Error("FASTCHAT_BOT_TOKEN is required");

const bot = new BotClient({
	token,
	baseUrl: process.env.FASTCHAT_BASE_URL ?? "http://localhost:8080",
});

bot.onMessage(async (message) => {
	await bot.sendMessage(message.chatId, `Эхо: ${message.text}`, {
		replyMarkup: {
			inlineKeyboard: [[{ text: "Повторить", callbackData: "again" }]],
		},
	});
});

bot.onCallbackQuery(async (query) => {
	await bot.answerCallbackQuery(query.id, "Нажато");
});

const shutdown = () => bot.stop();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await bot.start();
