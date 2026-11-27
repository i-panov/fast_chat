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
- `enableE2EE()` — returns `{ encryptionKey, identityKey }`
- `getUserDeviceKeys(userId)`
- `onMessage(handler)`
- `onCallbackQuery(handler)`
- `start(signal?)`
- `stop()`

The SDK only supports long polling. Bot chats are plaintext by default. Call
`enableE2EE()` once and persist both returned keys (`encryptionKey` and
`identityKey`) to switch existing and new bot chats to encrypted text,
encrypted inline keyboards, encrypted callback data, files and locations
(file keys and metadata travel inside the encrypted content).

Messages use payload v3: one envelope per participant's master key,
`crypto_box_easy`, Ed25519 identity signature and AAD
`chatId|messageId|fromId|threadId`. Legacy v1/v2 payloads are rejected.

### Breaking changes (v3)

- `enableE2EE()` returns `{ encryptionKey, identityKey }`. The deprecated
  `publicKey`/`privateKey` aliases still point at the encryption pair.
- `encryptBotReply`/`decryptBotMessage` require the identity key and message
  binding; callers that pass only the encryption key must be updated.
- A legacy E2EE bot (no identity) cannot be upgraded by calling `enableE2EE()`
  again: it generates a new encryption pair. Send `PUT
  /api/bot-api/encryption-key` manually with the **existing** `publicKey` and a
  new `identityPublicKey`; the server accepts it at the same version.

An E2EE bot can only send proactively to a chat after it has received a
message from that chat: the recipient's master key is unknown before that.
`sendMessage` rejects such an attempt with `BotApiError` instead of sending
plaintext.

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
