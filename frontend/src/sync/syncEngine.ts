import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import { applyDelta, maxSyncRounds, pullDelta } from "./deltaApplier.ts";
import { extractRetryAfterMs, processOutbox } from "./outboxProcessor.ts";

export type SyncState = "idle" | "syncing" | "error";

type Listener = (state: SyncState) => void;

const HTTP_STATUS_RE = /^http (\d{3})\b/;

const listeners = new Set<Listener>();
let currentState: SyncState = "idle";
let lastError: unknown = null;

let running = false;
let scheduled = false;
const debounceMs = 1000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// Retry state for transient sync failures. The timer is tracked so it can
// be cancelled on account/token change instead of firing into a foreign
// account's database; the attempt counter drives exponential backoff.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let onlineListenerArmed = false;
let retryAttempt = 0;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60_000;
const RETRY_JITTER_MS = 1000;

// In-flight delta fetch, abortable when the account changes mid-flight.
let inFlightController: AbortController | null = null;

function clearRetryTimer(): void {
	if (retryTimer !== null) {
		clearTimeout(retryTimer);
		retryTimer = null;
	}
}

function retryDelayMs(retryAfterMs: number | null): number {
	// An explicit Retry-After from the server is honoured exactly;
	// otherwise back off exponentially with jitter.
	if (retryAfterMs !== null) return retryAfterMs;
	const backoff = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retryAttempt);
	retryAttempt += 1;
	return backoff + Math.random() * RETRY_JITTER_MS;
}

function setState(next: SyncState) {
	if (currentState === next) return;
	currentState = next;
	for (const l of listeners) l(next);
}

export function getSyncState(): SyncState {
	return currentState;
}

export function getLastSyncError(): unknown {
	return lastError;
}

export function subscribeSyncState(fn: Listener): () => void {
	listeners.add(fn);
	return () => {
		listeners.delete(fn);
	};
}

export function scheduleSync(): void {
	if (debounceTimer !== null) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void runSync();
	}, debounceMs);
}

export async function runSync(): Promise<void> {
	if (running) {
		scheduled = true;
		return;
	}

	running = true;
	setState("syncing");
	try {
		await processOutboxAndPull();
		lastError = null;
		retryAttempt = 0;
		clearRetryTimer();
		setState("idle");
	} catch (err) {
		if (isTransientSyncError(err)) {
			// Transient failures (429 rate limiting, 5xx, network) must
			// not flip the UI to a permanent "error" state. Back off
			// (honouring Retry-After when present) and retry; the next
			// successful tick clears the state.
			lastError = null;
			setState("idle");
			const accountKey = getActiveAccountKey();
			const retryAfterMs = extractRetryAfterMs(err);
			clearRetryTimer();
			retryTimer = setTimeout(() => {
				retryTimer = null;
				// The account may have changed while waiting: do not sync
				// a foreign database with a stale tick.
				if (getActiveAccountKey() !== accountKey) return;
				void runSync();
			}, retryDelayMs(retryAfterMs));
		} else {
			lastError = err;
			setState("error");
		}
	} finally {
		running = false;
		if (scheduled) {
			scheduled = false;
			void runSync();
		}
	}
}

function isTransientSyncError(err: unknown): boolean {
	if (err instanceof Error) {
		const msg = err.message.toLowerCase();
		if (msg === "unauthorized") return false;
		const statusMatch = HTTP_STATUS_RE.exec(msg);
		if (statusMatch !== null) {
			const code = Number(statusMatch[1]);
			// 429 Too Many Requests and 5xx are transient; other 4xx are
			// definitive (bad request, forbidden, not found, ...).
			return code >= 500 || code === 429;
		}
		// Network errors (fetch failed, DNS, ...) are transient.
		return true;
	}
	return true;
}

async function processOutboxAndPull(): Promise<void> {
	const token = currentToken();
	if (token === null) return;
	// Capture the account up front: getDB() resolves the database lazily,
	// so an in-flight sync must not apply a foreign delta after a switch.
	const accountKey = getActiveAccountKey();

	if (typeof navigator !== "undefined" && !navigator.onLine) {
		// Offline: don't try to push or pull. Re-plan on the next online
		// event so the outbox does not hang when the transition was missed.
		// One shared listener: every offline tick would otherwise stack
		// another once-listener and burst N scheduleSync calls on reconnect.
		if (typeof window !== "undefined" && !onlineListenerArmed) {
			onlineListenerArmed = true;
			window.addEventListener(
				"online",
				() => {
					onlineListenerArmed = false;
					scheduleSync();
				},
				{ once: true },
			);
		}
		return;
	}

	await processOutbox(token);
	if (getActiveAccountKey() !== accountKey) return;

	const since = await metaRepo.getLastSyncedAt();
	if (getActiveAccountKey() !== accountKey) return;

	// Page through the delta: one response is bounded server-side, and
	// NextSince points at the continuation. Pages apply as they arrive
	// (bounded memory); every application is idempotent, so the overlap
	// at the cursor is harmless. applyDelta advances the stored cursor to
	// each page's serverNow; if the round budget runs out with more
	// pending, the cursor is parked back at the continuation so nothing
	// is skipped.
	const controller = new AbortController();
	inFlightController = controller;
	let cursor: string | null = since;
	let cursorID = "";
	try {
		for (let round = 0; ; round++) {
			const delta = await pullDelta(token, cursor, controller.signal, undefined, cursorID);
			if (getActiveAccountKey() !== accountKey) return;
			await applyDelta(delta);
			if (getActiveAccountKey() !== accountKey) return;
			const next = delta.nextSince ?? null;
			if (next === null || round + 1 >= maxSyncRounds) {
				if (next !== null) {
					// Park at the continuation (time-only across ticks;
					// the boundary tail redelivers idempotently).
					await metaRepo.setLastSyncedAt(next);
				}
				break;
			}
			cursor = next;
			cursorID = delta.nextSinceId ?? "";
		}
	} finally {
		if (inFlightController === controller) inFlightController = null;
	}
}

let tokenProvider: (() => string | null) | null = null;

export function setTokenProvider(fn: () => string | null): void {
	// A token change (account switch/logout) cancels the pending retry and
	// aborts the in-flight fetch so stale ticks never touch the new account.
	inFlightController?.abort();
	inFlightController = null;
	clearRetryTimer();
	retryAttempt = 0;
	tokenProvider = fn;
}

function currentToken(): string | null {
	return tokenProvider?.() ?? null;
}

// Retry all terminally failed outbox operations (except deletes).
// Only call this on explicit online transition, not on every sync
// tick — otherwise terminal errors (validation, bad request) would
// loop forever. See useChatInteraction.ts → handleBackOnline.
export async function retryFailedOps(): Promise<void> {
	const ops = await outboxRepo.list();
	const failed = ops.filter(
		(o) => o.status === "failed" && o.kind !== "delete",
	);

	for (const op of failed) {
		op.status = undefined;
		op.attempts = 0;
		await outboxRepo.update(op);

		if (op.kind === "send" || op.kind === "edit") {
			const messageId = op.kind === "send" ? op.msgId : op.messageId;
			if (op.threadId !== undefined) {
				await threadMessagesRepo.markStatus(op.threadId, messageId, "queued");
			} else {
				await messagesRepo.markStatus(op.chatId, messageId, "queued");
			}
		}
	}
}
