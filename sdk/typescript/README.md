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

## Encrypted files

`sendEncryptedFile` uploads ciphertext with the plaintext hash and sends hash-keyed `fileKeys`/`fileMeta`. `downloadFile` returns ciphertext; decrypt it with `decryptFileBytes` and the matching key. Locations travel in encrypted `sendMessage` content.

## Unified sending

`send()` chooses plaintext or E2EE from the bot mode. Pass raw file bytes and
optional location; the SDK uploads/encrypts and builds the content.

```ts
await bot.send(chatId, {
  text: "caption",
  files: [{ data, name: "photo.jpg", mimeType: "image/jpeg" }],
  location: { lat: 55.75, lng: 37.61 },
});
```

`sendEncryptedFile` is a compatibility wrapper. `sendFile`/`sendLocation`
delegate to the same mode-aware path.
