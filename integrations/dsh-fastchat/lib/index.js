/**
 * Fast Chat bridge for DeepSeek Harness.
 *
 * One bot token is bound to one workspace directory. Each Fast Chat chat gets
 * its own DSH session inside that directory, so different projects are never
 * mixed together.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { stat } from "node:fs/promises";
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { BotClient } from "@fastchat/bot";

export const name = "fastchat";

export const inject = ["agents", "tools"];

export const Config = z.object({
  bots: z.array(
    z.object({
      token: z.string(),
      cwd: z.string(),
      name: z.string().default(""),
      baseUrl: z.string().default("http://localhost:8080"),
      provider: z.string().default(""),
      model: z.string().default(""),
      preset: z.string().default("standard"),
      allowedChatIds: z.array(z.string()).default([]),
      allowedUserIds: z.array(z.string()).default([]),
    }),
  ),
});

function log(message, ...args) {
  console.log(`[fastchat] ${message}`, ...args);
}

function sessionIdFor(bot, chatId) {
  const digest = createHash("sha256")
    .update(`${bot.token}\0${bot.name}\0${bot.cwd}\0${chatId}`)
    .digest("hex")
    .slice(0, 20);
  return `session-fastchat-${digest}`;
}

function resultFromSession(session, firstSeq) {
  let started = false;
  let text = "";
  let files = [];
  for (let seq = firstSeq; seq < session.seq; seq += 1) {
    const event = session.eventAt(SessionSeq(seq));
    if (event === undefined) continue;
    if (event.type === "turn/start") {
      started = true;
      text = "";
      files = [];
      continue;
    }
    if (!started) continue;
    if (event.type === "assistant/message") {
      const joined = event.data.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (joined !== "") text = joined;
    }
    if (event.type === "deliverables/presented") {
      for (const file of event.data.files) {
        if (!files.some((item) => item.path === file.path)) files.push(file);
      }
    }
  }
  return { text, files };
}

async function saveIncomingFiles(bot, message) {
  if (!message.files || message.files.length === 0) return [];
  const dir = resolve(bot.cwd, ".fastchat", "incoming");
  await mkdir(dir, { recursive: true });
  const saved = [];
  for (const file of message.files) {
    try {
      const bytes = await bot.client.downloadFile(file.id);
      const safeName = String(file.originalName || file.id).replace(
        /[^a-zA-Z0-9._-]/g,
        "_",
      );
      const safeId = String(file.id).replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = join(dir, `${safeId}-${safeName}`);
      await writeFile(path, Buffer.from(bytes), { flag: "wx" });
      saved.push(path);
    } catch (error) {
      log(`could not download ${file.id}:`, error);
    }
  }
  return saved;
}

async function getAgent(ctx, bot, chatId, handles, handlesKey, sessionBots) {
  const sessionId = sessionIdFor(bot, chatId);
  const live = ctx.agents.get(sessionId);
  if (live !== undefined) {
    sessionBots.set(live.session.id, { bot, chatId });
    return live;
  }

  const options = {
    sessionId,
    meta: { cwd: resolve(bot.cwd) },
  };
  const presets = ctx.get("agentPresets");
  if (presets !== undefined) {
    const preset = await presets.resolve(bot.preset || "standard");
    options.meta.agentPreset = preset.id;
    options.setup = async (agentCtx) => {
      await presets.mount(agentCtx, preset.id);
    };
  }
  if ((bot.provider ?? "") !== "" && (bot.model ?? "") !== "") {
    options.agentOptions = { provider: bot.provider, model: bot.model };
  }
  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      setup: options.setup,
    });
    handles.set(handlesKey, handle);
    sessionBots.set(handle.agent.session.id, { bot, chatId });
    return handle.agent;
  } catch {
    const handle = await ctx.agents.create(options);
    handles.set(handlesKey, handle);
    sessionBots.set(handle.agent.session.id, { bot, chatId });
    return handle.agent;
  }
}

async function runBot(ctx, botConfig, signal, handles, sessionBots) {
  const cwd = await realpath(resolve(botConfig.cwd));
  const cwdStat = await stat(cwd);
  const home = await realpath(homedir());
  if (!cwdStat.isDirectory() || cwd === resolve("/") || cwd === home) {
    throw new Error(`refusing unsafe Fast Chat cwd: ${cwd}`);
  }
  const tokenHash = createHash("sha256").update(botConfig.token).digest("hex").slice(0, 16);
  const offsetPath = resolve(cwd, ".fastchat", `offset-${tokenHash}`);
  let initialOffset = 0;
  try {
    initialOffset = Number.parseInt(await readFile(offsetPath, "utf8"), 10) || 0;
  } catch {
    // first run
  }
  await mkdir(resolve(cwd, ".fastchat"), { recursive: true });
  let offsetWrite = Promise.resolve();
  const bot = {
    ...botConfig,
    cwd,
    client: new BotClient({
      token: botConfig.token,
      baseUrl: botConfig.baseUrl || "http://localhost:8080",
      initialOffset,
      onOffset: (offset) => {
        offsetWrite = offsetWrite
          .then(async () => {
            const tmp = `${offsetPath}.tmp`;
            await writeFile(tmp, String(offset));
            await rename(tmp, offsetPath);
          })
          .catch(() => {});
      },
    }),
  };
  const me = await bot.client.getMe();
  if (me.encryptionMode === "e2ee") {
    log(`bot ${bot.name || "unnamed"} is E2EE; this plugin has no key, skipping`);
    return;
  }
  const agentByChat = new Map();
  const queues = new Map();

  bot.client.onMessage((message) => {
    if (bot.allowedChatIds.length > 0 && !bot.allowedChatIds.includes(message.chatId)) {
      void bot.client.sendMessage(message.chatId, "This chat is not allowed.").catch(() => {});
      return;
    }
    if (bot.allowedUserIds.length > 0 && !bot.allowedUserIds.includes(message.from.id)) {
      void bot.client.sendMessage(message.chatId, "You are not allowed to use this bot.").catch(() => {});
      return;
    }
    const previous = queues.get(message.chatId) ?? Promise.resolve();
    const queue = previous
      .then(async () => {
        if (message.encrypted === true || message.undecryptable === true) {
          await bot.client.sendMessage(
            message.chatId,
            "This bot does not support E2EE messages.",
          );
          return;
        }
        const text = String(message.text || "").trim();
        const files = await saveIncomingFiles(bot, message);
        const parts = [text];
        for (const path of files) parts.push(`[file: ${path}]`);
        if (message.location) {
          parts.push(
            `[location: ${message.location.lat},${message.location.lng}]`,
          );
        }
        const prompt = parts.filter(Boolean).join("\n");
        if (prompt === "") return;

        let agent = agentByChat.get(message.chatId);
        if (agent === undefined) {
          agent = await getAgent(
            ctx,
            bot,
            message.chatId,
            handles,
            message.chatId,
            sessionBots,
          );
          agentByChat.set(message.chatId, agent);
        }
        const firstSeq = agent.session.seq;
        const typing = setInterval(() => {
          void bot.client.sendChatAction(message.chatId).catch(() => {});
        }, 4000);
        try {
          agent.followup(
            createUserMessage({
              content: [{ type: "text", text: prompt }],
              source: { kind: "user" },
            }),
          );
          await agent.whenIdle();
        } finally {
          clearInterval(typing);
        }
        const result = resultFromSession(agent.session, firstSeq);
        let answer = result.text.trim();
        for (const file of result.files) {
          try {
            const path = await realpath(resolve(bot.cwd, file.path));
            const rel = relative(bot.cwd, path);
            if (rel.startsWith("..") || isAbsolute(rel)) {
              throw new Error("presented file is outside the workspace");
            }
            const bytes = await readFile(path);
            const uploaded = await bot.client.uploadFile(
              new Uint8Array(bytes),
              basename(path),
            );
            await bot.client.sendFile(
              message.chatId,
              uploaded.id,
              file.description || answer,
            );
            if (file.description === undefined && answer !== "") {
              answer = "";
            }
          } catch (error) {
            log(`could not send presented file ${file.path}:`, error);
          }
        }
        if (answer !== "") await bot.client.sendMessage(message.chatId, answer);
      })
      .catch((error) => log(`turn failed:`, error));
    queues.set(message.chatId, queue);
  });

  log(`bot ${bot.name || "unnamed"} -> ${bot.cwd}`);
  await bot.client.start(signal);
}

async function apply(ctx, config) {
  const sessionBots = new Map();
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: "fastchat_send_location",
        description:
          "Send a latitude/longitude location to the Fast Chat chat that owns this session.",
        parameters: {
          latitude: { type: "number", required: true },
          longitude: { type: "number", required: true },
        },
        output: {
          schema: {
            type: "object",
            properties: { ok: { type: "boolean", required: true } },
            additionalProperties: false,
          },
          render: () => [{ type: "text", text: "Location sent" }],
        },
        execute: async (args, exec) => {
          const entry = exec.agent
            ? sessionBots.get(exec.agent.session.id)
            : undefined;
          if (entry === undefined) {
            throw new Error("Fast Chat session is not mapped to a chat");
          }
          await entry.bot.client.sendLocation(
            entry.chatId,
            args.latitude,
            args.longitude,
          );
          return { ok: true };
        },
      }),
      {
        when: ({ agent }) => sessionBots.has(agent.session.id),
      },
    ),
  );

  const bots = config.bots ?? [];
  for (const bot of bots) {
    if (!bot.token || !bot.cwd) continue;
    const handles = new Map();
    ctx.effect(() => {
      const controller = new AbortController();
      void runBot(ctx, bot, controller.signal, handles, sessionBots).catch(
        (error) => log(`bot ${bot.name || "unnamed"} failed:`, error),
      );
      return () => controller.abort();
    });
  }
}

export { apply };
