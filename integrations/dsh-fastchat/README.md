# Fast Chat plugin for DeepSeek Harness

Bridges Fast Chat bot chats to DSH agents.

Each configured bot is bound to exactly one project directory. Every Fast Chat
chat gets its own DSH session inside that directory, so separate projects are
never mixed in one conversation.

## Requirements

- DSH `0.2.2` or a compatible version;
- Node.js 20+;
- the Fast Chat TypeScript Bot SDK (it owns long polling).

## Install the Bot SDK into the DSH profile

From the Fast Chat repository:

```bash
cd sdk/typescript
npm install
npm run build
npm pack

dsh plugin --profile web add ./fastchat-bot-0.1.0.tgz
dsh plugin --profile web add /absolute/path/to/integrations/dsh-fastchat
```

`dsh plugin` forwards package operations to the profile's package manager. If
`@fastchat/bot` is published, the packed tarball step can be replaced with the
published package.

## Configure

Add one entry per project. The `cwd` is the project root the DSH agent must
work in.

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml (or the matching profile path)
- id: fastchat
  module: dsh-fastchat
  config:
    bots:
      - name: fastchat
        token: fcb_project_a_token
        cwd: /home/ilya/projects/project-a
        baseUrl: https://chat.example.com

      - name: billing
        token: fcb_project_b_token
        cwd: /home/ilya/projects/project-b
        baseUrl: https://chat.example.com
```

Create one bot per project through `@fastchat_bot`:

```text
/newbot
```

or through **Account → Bots** in the Fast Chat client.

## Behavior

- one Fast Chat bot per project folder;
- one DSH session per Fast Chat chat;
- the session ID is derived from bot name, `cwd`, and chat ID;
- DSH sessions are persisted and reused after restart;
- long polling is used, so no public IP or webhook is required;
- incoming files are downloaded to
  `<cwd>/.fastchat/incoming/<file-id>-<name>` and the path is included in the
  prompt;
- locations are included as `[location: lat,lng]`;
- the final assistant text is sent back to Fast Chat;
- files declared with the DSH `present` tool are uploaded and sent as Fast Chat
  file messages;
- `fastchat_send_location(latitude, longitude)` lets the agent send a
  location to the current Fast Chat chat;
- typing is sent while the DSH agent is working.

## Limitations

- Only files declared through `present` are uploaded automatically; arbitrary
  files mentioned in the final text are not scanned.
- `Config` has no hot-reload of bot tokens; restart the gateway after editing.
- Sessions are not shared with the DSH Web GUI; the bridge creates its own
  agent sessions.
- E2EE is not supported by this bridge; the Python/TypeScript Fast Chat SDK
  path would be required for encrypted bot chats.
