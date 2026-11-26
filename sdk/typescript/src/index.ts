import {
	decryptBotMessage,
	decryptCallbackData,
	encryptBotReply,
	encryptCallbackData,
	encryptFileBytes,
	generateEncryptionKeyPair,
	generateFileKey,
	hashBytes,
	type EncryptionKeyPair,
} from "./crypto.js";

export interface BotUser {
	id: string;
	username: string;
	displayName: string;
	isBot: boolean;
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

export interface BotChat {
	id: string;
	type: "private";
	username: string;
	displayName: string;
}

export interface BotFile {
	id: string;
	hash?: string;
	mimeType: string;
	size: number;
	originalName: string;
}

export interface BotLocation {
	lat: number;
	lng: number;
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
	fileKeys?: Record<string, import("./crypto.js").FileKey>;
	fileMeta?: Record<string, import("./crypto.js").FileMeta>;
	files?: BotFile[];
	location?: BotLocation;
	undecryptable?: boolean;
}

export interface BotCallbackQuery {
	id: string;
	from: BotUser;
	messageId: string;
	chatId: string;
	data: string;
	undecryptable?: boolean;
}

export interface BotUpdate {
	updateId: number;
	message?: BotMessage;
	callbackQuery?: BotCallbackQuery;
}

export interface BotFileInput {
	data: Uint8Array | ArrayBuffer | Blob;
	name: string;
	mimeType?: string;
}

export interface BotSendInput {
	text?: string;
	files?: BotFileInput[];
	location?: { lat: number; lng: number };
	replyMarkup?: InlineKeyboardMarkup;
}

export interface SendMessageOptions {
	replyMarkup?: InlineKeyboardMarkup;
	files?: string[];
	location?: { lat: number; lng: number };
	fileKeys?: Record<string, import("./crypto.js").FileKey>;
	fileMeta?: Record<string, import("./crypto.js").FileMeta>;
}

export interface BotClientOptions {
	token: string;
	baseUrl?: string;
	fetch?: typeof fetch;
	encryptionKey?: EncryptionKeyPair;
	initialOffset?: number;
	onOffset?: (offset: number) => void;
	mode?: "server" | "e2ee";
}

export interface UserDeviceKey {
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
	error?: string;
	code?: string | number;
	error_code?: number;
	description?: string;
}

interface RawUser {
	id: string;
	username: string;
	display_name: string;
	is_bot?: boolean;
	encryption_mode?: "server" | "e2ee";
}

interface RawMessage {
	message_id: string;
	chat_id: string;
	from: RawUser;
	text: string;
	encrypted?: boolean;
	encrypted_payload?: string;
	files?: BotFile[];
	location?: BotLocation;
	date: string;
	reply_markup?: {
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
	private offset: number;
	private encryptionKey?: EncryptionKeyPair;
	private mode?: "server" | "e2ee";
	private modeCheckedAt = 0;
	private readonly onOffset?: (offset: number) => void;
	private chatUsers = new Map<string, string>();
	private callbackUsers = new Map<string, string>();

	constructor(options: BotClientOptions) {
		this.token = options.token;
		this.baseUrl = (options.baseUrl ?? "http://localhost:8080").replace(/\/$/, "");
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.encryptionKey = options.encryptionKey;
		this.offset = options.initialOffset ?? 0;
		this.onOffset = options.onOffset;
		this.mode = options.mode;
		if (options.mode !== undefined) this.modeCheckedAt = Date.now();
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
		const user = toUser(await this.request<RawUser>("GET", "/api/bot-api/getMe"));
		this.mode = user.encryptionMode;
		return user;
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

	private async requireMode(): Promise<"server" | "e2ee"> {
		if (this.mode === undefined || Date.now() - this.modeCheckedAt > 60_000) {
			await this.getMe();
		}
		return this.mode ?? "server";
	}

	private async rejectPlaintextE2EE(): Promise<void> {
		if (this.encryptionKey === undefined && (await this.requireMode()) === "e2ee") {
			throw new BotApiError("bot is in e2ee mode; an encryption key is required", 0, 0);
		}
	}

	async send(chatId: string, input: BotSendInput): Promise<BotMessage> {
		const mode = await this.requireMode();
		const files = input.files ?? [];
		const fileIDs: string[] = [];
		const fileKeys: Record<string, import("./crypto.js").FileKey> = {};
		const fileMeta: Record<string, import("./crypto.js").FileMeta> = {};
		for (const file of files) {
			const data = file.data instanceof Blob
				? new Uint8Array(await file.data.arrayBuffer())
				: file.data instanceof ArrayBuffer
					? new Uint8Array(file.data)
					: file.data;
			const mimeType = file.mimeType ?? "application/octet-stream";
			if (mode === "e2ee") {
				const hash = await hashBytes(data);
				const key = await generateFileKey();
				const ciphertext = await encryptFileBytes(data, key);
				const uploaded = await this.uploadFile(ciphertext, file.name, mimeType, {
					encrypted: true,
					hash,
				});
				fileIDs.push(uploaded.id);
				fileKeys[hash] = key;
				fileMeta[hash] = { mimeType, name: file.name, size: data.byteLength };
			} else {
				const uploaded = await this.uploadFile(data, file.name, mimeType);
				fileIDs.push(uploaded.id);
			}
		}
		return this.sendMessage(chatId, input.text ?? "", {
			files: fileIDs,
			location: input.location,
			fileKeys: mode === "e2ee" ? fileKeys : undefined,
			fileMeta: mode === "e2ee" ? fileMeta : undefined,
			replyMarkup: input.replyMarkup,
		});
	}

	async sendMessage(
		chatId: string,
		text: string,
		options?: SendMessageOptions,
	): Promise<BotMessage> {
		const e2ee = (await this.requireMode()) === "e2ee";
		if (e2ee) {
			if (this.encryptionKey === undefined) {
				throw new BotApiError("bot is in e2ee mode; an encryption key is required", 0, 0);
			}
			const userID = this.chatUsers.get(chatId);
			if (userID === undefined) {
				// Proactive messages carry no user context, so the device keys
				// to encrypt for are unknown. Keep the same error type as the
				// rest of the Bot API instead of a bare Error.
				throw new BotApiError(
					"cannot send an E2EE message before receiving a message from this chat",
					0,
					0,
				);
			}
			const devices = await this.getUserDeviceKeys(userID);
			const encrypted = await encryptBotReply(
				text,
				devices,
				await this.encryptedMarkup(options?.replyMarkup),
				{
					location: options?.location,
					fileKeys: options?.fileKeys,
					fileMeta: options?.fileMeta,
				},
			);
			const raw = await this.request<RawMessage>(
				"POST",
				"/api/bot-api/sendMessage",
				{
					chat_id: chatId,
					text: encrypted.text,
					encrypted: true,
					encrypted_payload: encrypted.payload,
					files: options?.files?.map((id) => ({ id })),
				},
			);
			return { ...(await this.toMessage(raw, false)), text };
		}
		await this.rejectPlaintextE2EE();
		const raw = await this.request<RawMessage>(
			"POST",
			"/api/bot-api/sendMessage",
			{
				chat_id: chatId,
				text,
				files: options?.files?.map((id) => ({ id })),
				location: options?.location,
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
		if (
			(options?.files?.length ?? 0) > 0 ||
			options?.location !== undefined ||
			options?.fileKeys !== undefined ||
			options?.fileMeta !== undefined
		) {
			throw new BotApiError("editMessageText does not support files or location", 0, 0);
		}
		const e2ee = (await this.requireMode()) === "e2ee";
		if (e2ee) {
			if (this.encryptionKey === undefined) {
				throw new BotApiError("bot is in e2ee mode; an encryption key is required", 0, 0);
			}
			const userID = this.chatUsers.get(chatId);
			if (userID === undefined) {
				// Proactive messages carry no user context, so the device keys
				// to encrypt for are unknown. Keep the same error type as the
				// rest of the Bot API instead of a bare Error.
				throw new BotApiError(
					"cannot send an E2EE message before receiving a message from this chat",
					0,
					0,
				);
			}
			const devices = await this.getUserDeviceKeys(userID);
			const encrypted = await encryptBotReply(
				text,
				devices,
				await this.encryptedMarkup(options?.replyMarkup),
				{
					location: options?.location,
					fileKeys: options?.fileKeys,
					fileMeta: options?.fileMeta,
				},
			);
			const raw = await this.request<RawMessage>(
				"POST",
				"/api/bot-api/editMessageText",
				{
					chat_id: chatId,
					message_id: messageId,
					text: encrypted.text,
					encrypted: true,
					encrypted_payload: encrypted.payload,
					files: options?.files?.map((id) => ({ id })),
				},
			);
			return { ...(await this.toMessage(raw, false)), text };
		}
		await this.rejectPlaintextE2EE();
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

	async sendEncryptedFile(
		chatId: string,
		data: Uint8Array,
		filename: string,
		mimeType = "application/octet-stream",
		caption = "",
	): Promise<BotMessage> {
		if ((await this.requireMode()) !== "e2ee") {
			throw new BotApiError("sendEncryptedFile requires an e2ee bot", 0, 0);
		}
		return this.send(chatId, {
			text: caption,
			files: [{ data, name: filename, mimeType }],
		});
	}

	async deleteMessage(chatId: string, messageId: string): Promise<void> {
		await this.request("POST", "/api/bot-api/deleteMessage", {
			chat_id: chatId,
			message_id: messageId,
		});
	}


	async uploadFile(
		data: Uint8Array | ArrayBuffer | Blob,
		filename: string,
		mimeType = "application/octet-stream",
		options?: { encrypted?: boolean; hash?: string },
	): Promise<BotFile> {
		if (
			(await this.requireMode()) === "e2ee" &&
			options?.encrypted !== true
		) {
			throw new Error("encrypted upload is required in e2ee mode");
		}
		if (options?.encrypted === true && options.hash === undefined) {
			throw new Error("plaintext hash is required for encrypted uploads");
		}
		const form = new FormData();
		const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
		form.append("file", blob, filename);
		if (options?.encrypted === true) form.append("encrypted", "true");
		if (options?.hash !== undefined) form.append("hash", options.hash);
		const response = await this.fetchImpl(`${this.baseUrl}/api/bot-api/uploadFile`, {
			method: "POST",
			headers: { Authorization: `Bearer ${this.token}` },
			body: form,
		});
		if (!response.ok) throw new BotApiError(await response.text(), response.status, response.status);
		const result = (await response.json()) as { file: BotFile };
		return result.file;
	}

	async downloadFile(fileId: string, maxBytes = 50 * 1024 * 1024): Promise<ArrayBuffer> {
		const response = await this.fetchImpl(
			`${this.baseUrl}/api/bot-api/files/${encodeURIComponent(fileId)}`,
			{ headers: { Authorization: `Bearer ${this.token}` } },
		);
		if (!response.ok) throw new BotApiError(await response.text(), response.status, response.status);
		const body = await response.arrayBuffer();
		if (body.byteLength > maxBytes) throw new BotApiError("file is too large", 0, 0);
		return body;
	}

	async sendFile(
		chatId: string,
		file: string | BotFileInput,
		caption?: string,
	): Promise<BotMessage> {
		if (typeof file !== "string") {
			return this.send(chatId, { text: caption ?? "", files: [file] });
		}
		if ((await this.requireMode()) === "e2ee") {
			throw new Error("sendFile requires raw file data in e2ee mode");
		}
		const raw = await this.request<RawMessage>(
			"POST",
			"/api/bot-api/sendFile",
			{ chat_id: chatId, file_id: file, caption },
		);
		return toMessage(raw);
	}

	async sendLocation(
		chatId: string,
		latitude: number,
		longitude: number,
	): Promise<BotMessage> {
		return this.send(chatId, { text: "", location: { lat: latitude, lng: longitude } });
	}

	async getChat(chatId: string): Promise<BotChat> {
		return this.request<BotChat>("POST", "/api/bot-api/getChat", {
			chat_id: chatId,
		});
	}

	async sendChatAction(chatId: string, action = "typing"): Promise<void> {
		await this.request("POST", "/api/bot-api/sendChatAction", {
			chat_id: chatId,
			action,
		});
	}

	async answerCallbackQuery(
		callbackQueryId: string,
		text?: string,
		showAlert = false,
	): Promise<void> {
		if (this.encryptionKey !== undefined && text !== undefined && text !== "") {
			const userID = this.callbackUsers.get(callbackQueryId);
			if (userID === undefined) throw new Error("unknown callback user");
			const devices = await this.getUserDeviceKeys(userID);
			const encrypted = await encryptBotReply(text, devices);
			await this.request("POST", "/api/bot-api/answerCallbackQuery", {
				callback_query_id: callbackQueryId,
				text: encrypted.text,
				show_alert: showAlert,
				encrypted: true,
				encrypted_payload: encrypted.payload,
			});
			return;
		}
		if (text !== undefined && text !== "") await this.rejectPlaintextE2EE();
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
		this.mode = "e2ee";
		return key;
	}

	private async encryptedMarkup(
		markup?: InlineKeyboardMarkup,
	): Promise<Array<Array<{ text: string; callbackData?: string; url?: string }>> | undefined> {
		if (markup === undefined || this.encryptionKey === undefined) return undefined;
		return Promise.all(
			markup.inlineKeyboard.map(async (row) =>
				Promise.all(
					row.map(async (button) => {
						const callbackData =
							button.callbackData === undefined
								? undefined
								: await encryptCallbackData(
										button.callbackData,
										this.encryptionKey?.publicKey ?? "",
									);
						if (callbackData !== undefined && callbackData.length > 256) {
							throw new BotApiError("encrypted callback data is too long", 0, 0);
						}
						return { text: button.text, callbackData, url: button.url };
					}),
				),
			),
		);
	}

	async getUserDeviceKeys(userID: string): Promise<UserDeviceKey[]> {
		const result = await this.request<
			| Array<{ id: string; publicKey: string }>
			| { devices: Array<{ id: string; publicKey: string }> }
		>("POST", "/api/bot-api/getUserDeviceKeys", { userId: userID });
		const devices = Array.isArray(result) ? result : result.devices;
		return devices.map((device) => ({
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
		let handlerFailures = 0;

		try {
			while (this.running) {
				try {
					const updates = await this.getUpdates({
						offset: this.offset,
						signal: this.controller.signal,
					});
					backoff = 1000;
					for (const update of updates) {
						try {
							if (update.message !== undefined) {
								for (const handler of this.messageHandlers) await handler(update.message);
							}
							if (update.callbackQuery !== undefined) {
								for (const handler of this.callbackHandlers) await handler(update.callbackQuery);
							}
						} catch {
							if (!this.running) return;
							handlerFailures += 1;
							if (handlerFailures < 3) {
								await sleep(backoff, this.controller.signal);
								backoff = Math.min(backoff * 2, 30_000);
								break;
							}
							handlerFailures = 0;
						}
						handlerFailures = 0;
						this.offset = Math.max(this.offset, update.updateId + 1);
						this.onOffset?.(this.offset);
					}
				} catch (error) {
					if (!this.running || this.controller.signal.aborted) return;
					await sleep(backoff, this.controller.signal);
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
		let message: BotMessage | undefined;
		if (raw.message !== undefined) {
			message = await this.toMessage(raw.message);
		}
		let callbackQuery: BotCallbackQuery | undefined;
		if (raw.callback_query !== undefined) {
			let data = raw.callback_query.data;
			let undecryptable = false;
			if (this.encryptionKey !== undefined) {
				try {
					data = await decryptCallbackData(data, this.encryptionKey);
				} catch {
					undecryptable = true;
				}
			} else if (data.startsWith("fcbenc:")) {
				undecryptable = true;
			}
			callbackQuery = {
				id: raw.callback_query.id,
				from: toUser(raw.callback_query.from),
				messageId: raw.callback_query.message_id,
				chatId: raw.callback_query.chat_id,
				data,
				undecryptable,
			};
			this.callbackUsers.set(callbackQuery.id, callbackQuery.from.id);
			this.chatUsers.set(callbackQuery.chatId, callbackQuery.from.id);
		}
		return { updateId: raw.update_id, message, callbackQuery };
	}

	private async toMessage(raw: RawMessage, decrypt = true): Promise<BotMessage> {
		const base = toMessage(raw);
		if (
			decrypt &&
			raw.encrypted === true &&
			(this.encryptionKey === undefined || raw.encrypted_payload === undefined)
		) {
			base.undecryptable = true;
			base.text = "[encrypted message]";
		}
		if (decrypt && this.encryptionKey !== undefined && raw.encrypted === true && raw.encrypted_payload !== undefined) {
			try {
				const me = await this.getMe();
				const content = await decryptBotMessage(
					raw.text,
					raw.encrypted_payload,
					me.id ?? "",
					this.encryptionKey,
					{
						chatId: raw.chat_id,
						messageId: raw.message_id,
						fromId: raw.from.id,
					},
				);
				base.text = typeof content.text === "string" ? content.text : "";
				base.location = content.location;
				base.fileKeys = content.fileKeys;
				base.fileMeta = content.fileMeta;
				base.files = (raw.files ?? [])
					.filter((file) => file.hash !== undefined && content.fileMeta?.[file.hash] !== undefined)
					.map((file) => {
					const meta = file.hash === undefined ? undefined : content.fileMeta?.[file.hash];
					return meta === undefined
						? file
						: {
								...file,
								mimeType: meta.mimeType,
								originalName: meta.name,
								size: meta.size,
							};
				});
				const markup = content.replyMarkup;
				if (markup !== undefined && markup !== null && typeof markup === "object") {
					const rows = (markup as { inline_keyboard?: unknown }).inline_keyboard;
					if (Array.isArray(rows)) {
						base.replyMarkup = {
							inlineKeyboard: rows
								.filter(Array.isArray)
								.map((row) =>
									(row as Array<{ text?: unknown; callback_data?: unknown; url?: unknown }>)
										.filter((button) => typeof button?.text === "string")
										.map((button) => ({
											text: button.text as string,
											callbackData:
												typeof button.callback_data === "string"
													? button.callback_data
													: undefined,
											url: typeof button.url === "string" ? button.url : undefined,
										})),
								),
						};
					}
				}
			} catch {
				base.undecryptable = true;
				base.text = "[encrypted message]";
			}
		}
		if (!base.from.isBot) this.chatUsers.set(base.chatId, base.from.id);
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
				envelope.error ?? envelope.description ?? `HTTP ${response.status}`,
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
		isBot: raw.is_bot ?? false,
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
		files: raw.files,
		location: raw.location,
		date: raw.date,
		replyMarkup:
			raw.reply_markup === undefined
				? undefined
				: {
						inlineKeyboard: raw.reply_markup.inline_keyboard.map((row) =>
							row.map((button) => ({
								text: button.text,
								callbackData: button.callback_data,
								url: button.url,
							})),
						),
					},
	};
}


function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted === true) {
			resolve();
			return;
		}
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(finish, ms);
		const onAbort = () => finish();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export {
	decryptBotMessage,
	decryptCallbackData,
	decryptFileBytes,
	encryptBotReply,
	encryptCallbackData,
	encryptFileBytes,
	generateEncryptionKeyPair,
	generateFileKey,
	hashBytes,
} from "./crypto.js";
export type { FileKey, FileMeta } from "./crypto.js";
export type { EncryptionKeyPair } from "./crypto.js";
