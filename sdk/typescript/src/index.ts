import { decryptBotMessage, encryptBotReply, generateEncryptionKeyPair, type EncryptionKeyPair } from "./crypto.js";

export interface BotUser {
	id: string;
	username: string;
	displayName: string;
	isBot: true;
	encryptionMode: "server" | "e2ee";
}

export interface InlineKeyboardButton {
	text: string;
	callbackData?: string;
	url?: string;
}

export interface InlineKeyboardMarkup {
	inlineKeyboard: InlineKeyboardButton[][];
}

export interface BotMessage {
	messageId: string;
	chatId: string;
	from: BotUser;
	text: string;
	date: string;
	replyMarkup?: InlineKeyboardMarkup;
	encrypted?: boolean;
	encryptedPayload?: string;
}

export interface BotCallbackQuery {
	id: string;
	from: BotUser;
	messageId: string;
	chatId: string;
	data: string;
}

export interface BotUpdate {
	updateId: number;
	message?: BotMessage;
	callbackQuery?: BotCallbackQuery;
}

export interface SendMessageOptions {
	replyMarkup?: InlineKeyboardMarkup;
}

export interface BotClientOptions {
	token: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	encryptionKey?: EncryptionKeyPair;
}

interface UserDeviceKey {
	id: string;
	publicKey: string;
}

export class BotApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: number,
	) {
		super(message);
		this.name = "BotApiError";
	}
}

type Handler<T> = (value: T) => void | Promise<void>;

interface ApiEnvelope<T> {
	ok: boolean;
	result: T;
	error_code?: number;
	description?: string;
}

interface RawUser {
	id: string;
	username: string;
	display_name: string;
	is_bot: boolean;
	encryption_mode?: "server" | "e2ee";
}

interface RawMessage {
	message_id: string;
	chat_id: string;
	from: RawUser;
	text: string;
	encrypted?: boolean;
	encrypted_payload?: string;
	date: string;
	replyMarkup?: {
		inline_keyboard: Array<
			Array<{ text: string; callback_data?: string; url?: string }>
		>;
	};
}

interface RawUpdate {
	update_id: number;
	message?: RawMessage;
	callback_query?: {
		id: string;
		from: RawUser;
		message_id: string;
		chat_id: string;
		data: string;
	};
}

export class BotClient {
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly messageHandlers: Handler<BotMessage>[] = [];
	private readonly callbackHandlers: Handler<BotCallbackQuery>[] = [];
	private running = false;
	private controller: AbortController | null = null;
	private offset = 0;
	private encryptionKey?: EncryptionKeyPair;
	private chatUsers = new Map<string, string>();

	constructor(options: BotClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.encryptionKey = options.encryptionKey;
	}

	onMessage(handler: Handler<BotMessage>): this {
		this.messageHandlers.push(handler);
		return this;
	}

	onCallbackQuery(handler: Handler<BotCallbackQuery>): this {
		this.callbackHandlers.push(handler);
		return this;
	}

	async getMe(): Promise<BotUser> {
		return toUser(
			await this.request<RawUser>("GET", "/api/bot-api/getMe"),
		);
	}

	async getUpdates(options?: {
		offset?: number;
		limit?: number;
		timeout?: number;
		signal?: AbortSignal;
	}): Promise<BotUpdate[]> {
		const raw = await this.request<RawUpdate[]>(
			"POST",
			"/api/bot-api/getUpdates",
			{
				offset: options?.offset ?? this.offset,
				limit: options?.limit ?? 100,
				timeout: options?.timeout ?? 25,
			},
			options?.signal,
		);
		return Promise.all(raw.map((update) => this.toUpdate(update)));
	}

	async sendMessage(
		chatId: string,
		text: string,
		options?: SendMessageOptions,
	): Promise<BotMessage> {
		if (this.encryptionKey !== undefined) {
			if (options?.replyMarkup !== undefined) {
				throw new Error("inline buttons are not supported in e2ee mode");
			}
			const userID = this.chatUsers.get(chatId);
			if (userID === undefined) throw new Error("unknown chat user");
			const devices = await this.getUserDeviceKeys(userID);
			const encrypted = await encryptBotReply(text, devices);
			const raw = await this.request<RawMessage>(
				"POST",
				"/api/bot-api/sendMessage",
				{
					chat_id: chatId,
					text: encrypted.text,
					encrypted: true,
					encrypted_payload: encrypted.payload,
				},
			);
			return { ...(await this.toMessage(raw, false)), text };
		}
		const raw = await this.request<RawMessage>(
			"POST",
			"/api/bot-api/sendMessage",
			{
				chat_id: chatId,
				text,
				reply_markup:
					options?.replyMarkup === undefined
						? undefined
						: {
								inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) =>
									row.map((button) => ({
										text: button.text,
										callback_data: button.callbackData,
										url: button.url,
									})),
								),
							},
			},
		);
		return toMessage(raw);
	}

	async editMessageText(
		chatId: string,
		messageId: string,
		text: string,
		options?: SendMessageOptions,
	): Promise<BotMessage> {
		const raw = await this.request<RawMessage>(
			"POST",
			"/api/bot-api/editMessageText",
			{
				chat_id: chatId,
				message_id: messageId,
				text,
				reply_markup:
					options?.replyMarkup === undefined
						? undefined
						: {
								inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) =>
									row.map((button) => ({
										text: button.text,
										callback_data: button.callbackData,
										url: button.url,
									})),
								),
							},
			},
		);
		return toMessage(raw);
	}

	async deleteMessage(chatId: string, messageId: string): Promise<void> {
		await this.request("POST", "/api/bot-api/deleteMessage", {
			chat_id: chatId,
			message_id: messageId,
		});
	}


	async answerCallbackQuery(
		callbackQueryId: string,
		text?: string,
		showAlert = false,
	): Promise<void> {
		await this.request("POST", "/api/bot-api/answerCallbackQuery", {
			callback_query_id: callbackQueryId,
			text,
			show_alert: showAlert,
		});
	}

	async enableE2EE(): Promise<EncryptionKeyPair> {
		const key = await generateEncryptionKeyPair();
		await this.request("PUT", "/api/bot-api/encryption-key", {
			publicKey: key.publicKey,
		});
		this.encryptionKey = key;
		return key;
	}

	async getUserDeviceKeys(userID: string): Promise<UserDeviceKey[]> {
		const result = await this.request<{ devices: Array<{ id: string; publicKey: string }> }>(
			"POST",
			"/api/bot-api/getUserDeviceKeys",
			{ userId: userID },
		);
		return result.devices.map((device) => ({
			id: device.id,
			publicKey: device.publicKey,
		}));
	}

	/** Starts the long-polling loop. Rejects only on unexpected errors. */
	async start(signal?: AbortSignal): Promise<void> {
		if (this.running) throw new Error("polling already started");
		this.running = true;
		this.controller = new AbortController();
		const abort = () => this.controller?.abort();
		signal?.addEventListener("abort", abort, { once: true });
		let backoff = 1000;

		try {
			while (this.running) {
				try {
					const updates = await this.getUpdates({
						offset: this.offset,
						signal: this.controller.signal,
					});
					backoff = 1000;
					for (const update of updates) {
						this.offset = Math.max(this.offset, update.updateId + 1);
						if (update.message !== undefined) {
							for (const handler of this.messageHandlers) await handler(update.message);
						}
						if (update.callbackQuery !== undefined) {
							for (const handler of this.callbackHandlers) await handler(update.callbackQuery);
						}
					}
				} catch (error) {
					if (!this.running || this.controller.signal.aborted) return;
					await sleep(backoff);
					backoff = Math.min(backoff * 2, 30_000);
				}
			}
		} finally {
			this.running = false;
			signal?.removeEventListener("abort", abort);
		}
	}

	stop(): void {
		this.running = false;
		this.controller?.abort();
	}

	private async toUpdate(raw: RawUpdate): Promise<BotUpdate> {
		const message = raw.message === undefined ? undefined : await this.toMessage(raw.message);
		return {
			updateId: raw.update_id,
			message,
			callbackQuery:
				raw.callback_query === undefined
					? undefined
					: {
							id: raw.callback_query.id,
							from: toUser(raw.callback_query.from),
							messageId: raw.callback_query.message_id,
							chatId: raw.callback_query.chat_id,
							data: raw.callback_query.data,
						},
		};
	}

	private async toMessage(raw: RawMessage, decrypt = true): Promise<BotMessage> {
		const base = toMessage(raw);
		if (decrypt && this.encryptionKey !== undefined && raw.encrypted === true && raw.encrypted_payload !== undefined) {
			const me = await this.getMe();
			const content = await decryptBotMessage(raw.text, raw.encrypted_payload, me.id, this.encryptionKey);
			base.text = content.text;
		}
		this.chatUsers.set(base.chatId, base.from.id);
		return base;
	}

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": "application/json",
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal,
		});
		let envelope: ApiEnvelope<T>;
		try {
			envelope = (await response.json()) as ApiEnvelope<T>;
		} catch {
			throw new BotApiError("invalid JSON response", response.status, response.status);
		}
		if (!response.ok || envelope.ok !== true) {
			throw new BotApiError(
				envelope.description ?? `HTTP ${response.status}`,
				response.status,
				envelope.error_code ?? response.status,
			);
		}
		return envelope.result;
	}
}

function toUser(raw: RawUser): BotUser {
	return {
		id: raw.id,
		username: raw.username,
		displayName: raw.display_name,
		isBot: true,
		encryptionMode: raw.encryption_mode ?? "server",
	};
}

function toMessage(raw: RawMessage): BotMessage {
	return {
		messageId: raw.message_id,
		chatId: raw.chat_id,
		from: toUser(raw.from),
		text: raw.text,
		encrypted: raw.encrypted,
		encryptedPayload: raw.encrypted_payload,
		date: raw.date,
		replyMarkup:
			raw.replyMarkup === undefined
				? undefined
				: {
						inlineKeyboard: raw.replyMarkup.inline_keyboard.map((row) =>
							row.map((button) => ({
								text: button.text,
								callbackData: button.callback_data,
								url: button.url,
							})),
						),
					},
	};
}


function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
