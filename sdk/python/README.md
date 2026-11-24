# fastchat-bot (Python)

Python client for the Fast Chat Bot API (standard-library HTTP plus PyNaCl for E2EE).

```python
from fastchat_bot import BotClient

bot = BotClient("fcb_...", "https://chat.example.com")
me = bot.get_me()
print(me.username)

for update in bot.get_updates():
    if update.message:
        bot.send_message(update.message.chat_id, f"echo: {update.message.text}")
```

## Methods

- `get_me()`
- `get_updates(offset=0, limit=100, timeout=25)`
- `send_message(chat_id, text, reply_markup=...)`
- `edit_message_text(chat_id, message_id, text, reply_markup=...)`
- `delete_message(chat_id, message_id)`
- `get_chat(chat_id)`
- `send_chat_action(chat_id, action="typing")`
- `answer_callback_query(callback_query_id, text=None, show_alert=False)`
- `upload_file(data, filename, mime_type=...)`
- `send_file(chat_id, file_id, caption=None)`
- `send_location(chat_id, latitude, longitude)`
- `download_file(file_id)`
- `enable_e2ee()`
- `get_user_device_keys(user_id)`
- `run(on_message=..., on_callback=..., stop=..., initial_offset=0)`

## E2EE

```python
bot = BotClient(token)
key = bot.enable_e2ee()          # save key.public_key/key.private_key
...

bot = BotClient(token, encryption_key=key)
```

The wire format matches the TypeScript SDK and browser client. Sending an
E2EE message requires the bot to have already received a message in that chat,
because the user device keys are discovered from updates.

## Install

```bash
uv pip install -e sdk/python
```

## Limits

E2EE is supported for text, inline keyboards, callback data and callback
answers. Files and locations remain plaintext-only, matching the server
protocol. Pass a saved `EncryptionKeyPair` to `BotClient` after the first
`enable_e2ee()` call; the SDK does not persist private keys.

## Encrypted files

`send_encrypted_file` uploads ciphertext with the plaintext hash and sends hash-keyed `file_keys`/`file_meta`. `download_file` returns ciphertext; use `decrypt_file_bytes` with the matching key. Locations travel in encrypted `send_message` content.

## Unified sending

`send()` chooses plaintext or E2EE from the bot mode and accepts raw files and
location.

```python
bot.send(
    chat_id,
    "caption",
    files=[{"data": data, "name": "photo.jpg", "mime_type": "image/jpeg"}],
    location={"lat": 55.75, "lng": 37.61},
)
```

`send_encrypted_file` is a compatibility wrapper. `send_file`/`send_location`
delegate to the same mode-aware path.
