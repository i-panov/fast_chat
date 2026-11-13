# @fastchat/bot

TypeScript SDK for the Fast Chat Bot API.

```ts
import { BotClient } from "@fastchat/bot";

const bot = new BotClient({
  token: process.env.FASTCHAT_BOT_TOKEN!,
  baseUrl: "http://localhost:8080",
});

bot.onMessage(async (message) => {
  await bot.sendMessage(message.chatId, `Эхо: ${message.text}`);
});

await bot.start();
```

## API

- `getMe()`
- `getUpdates({ offset, limit, timeout })`
- `sendMessage(chatId, text, { replyMarkup })`
- `answerCallbackQuery(id, text?, showAlert?)`
- `onMessage(handler)`
- `onCallbackQuery(handler)`
- `start(signal?)`
- `stop()`

The SDK only supports long polling. Bot chats are currently plaintext; E2EE
for bots is a future mode.
