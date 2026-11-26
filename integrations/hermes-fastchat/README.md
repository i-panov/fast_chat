# Fast Chat plugin for Hermes Agent

Connects a Hermes Agent to a Fast Chat bot. Hermes plugins are Python, so the
plugin uses the standalone Python Bot SDK from `sdk/python`; no Node bridge is
required.

## Install the Python SDK

From the Fast Chat repository:

Use the `uv` that Hermes runs with, so the SDK lands in the same environment:

```bash
uv pip install -e sdk/python
```

If the SDK is published separately:

```bash
uv pip install fastchat-bot
```

## Install the plugin

Copy this directory into the Hermes plugin directory:

```bash
mkdir -p ~/.hermes/plugins
cp -R integrations/hermes-fastchat ~/.hermes/plugins/fastchat
hermes plugins enable fastchat
```

Or install it as a pip-distributed plugin with the entry point from
`pyproject.toml`.

## Create a bot

In Fast Chat, open `@root_bot` and send `/newbot`, or use
**Account → Bots**. Copy the `fcb_...` token.

## Configure

```bash
export FASTCHAT_BOT_TOKEN="fcb_..."
export FASTCHAT_BOT_BASE_URL="https://chat.example.com"
```

Or in `~/.hermes/config.yaml`:

```yaml
gateway:
  platforms:
    fastchat:
      enabled: true
      extra:
        token: "fcb_..."
        base_url: "https://chat.example.com"
```

Optional access control:

```bash
export FASTCHAT_ALLOW_ALL_USERS=false
export FASTCHAT_ALLOWED_USERS="alice:example.com,bob:example.com"
```

The user ID is the Fast Chat ID, e.g. `alice:chat.example.com`.

Start the gateway:

```bash
hermes gateway
```

## What works

- long polling through the Fast Chat Bot API;
- text messages in both directions;
- typing indicators (`send_chat_action`);
- chat lookup;
- incoming files are downloaded to temporary local paths and exposed to Hermes
  as `media_urls` / `media_types`; image/video/audio/document message types are
  preserved;
- incoming locations are passed as `MessageType.LOCATION` with the coordinates
  in the text;
- outgoing files, images, voice and video are uploaded through the Fast Chat
  Bot API and sent as file messages;
- `fastchat_send_location` tool lets the agent send latitude/longitude; it
  uses the adapter's env credentials and never accepts token/base URL from the model.
  The tool only targets the chat whose message is currently being processed
  (or the only known chat); a `chat_id` from another conversation is rejected.
  The credential registry is process-wide, bounded and entries expire after 24 h;
- `/help` and slash commands work through the normal Hermes gateway flow.

The adapter uses `asyncio.to_thread` around the Python Bot SDK, so it does not
block the gateway event loop during long polling or file upload.

## Limitations

- The Python SDK supports E2EE, but this Hermes adapter does not configure a
  saved bot key yet. An E2EE bot is rejected at connect instead of passing
  ciphertext to the model.
- Outgoing locations are available through the `fastchat_send_location` tool
  rather than the generic `send_message` tool.
- Incoming files are kept in temporary files for the adapter lifetime; they are
  removed on disconnect.
- Hermes renders Markdown; Fast Chat bot chats are plain text, so platform_hint
  tells the model to keep formatting simple.
