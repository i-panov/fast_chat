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
- `editMessageText(chatId, messageId, text, { replyMarkup })`
- `deleteMessage(chatId, messageId)`
- `getChat(chatId)`
- `sendChatAction(chatId, action)`
- `uploadFile(data, filename, mimeType?)`
- `sendFile(chatId, fileId, caption?)`
- `downloadFile(fileId)`
- `sendLocation(chatId, latitude, longitude)`
- `answerCallbackQuery(id, text?, showAlert?)`
- `enableE2EE()`
- `getUserDeviceKeys(userId)`
- `onMessage(handler)`
- `onCallbackQuery(handler)`
- `start(signal?)`
- `stop()`

The SDK only supports long polling. Bot chats are plaintext by default. Call
`enableE2EE()` once and persist the returned key pair to switch existing and
new bot chats to encrypted text, encrypted inline keyboards and encrypted
callback data. Files and locations are plaintext and are not available in
E2EE mode.
