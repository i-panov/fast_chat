import { getActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { threadMessagesRepo } from "../db/threadMessagesRepo.ts";
import {
	applyDelta,
	maxSyncRounds,
	pullDelta,
	resetLocalTombstones,
} from "./deltaApplier.ts";
import {
	extractRetryAfterMs,
	type OutboxResult,
	processOutbox,
} from "./outboxProcessor.ts";

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

// Parked continuation of a tick that hit maxSyncRounds. The keyset cursor is
// (updated_at, id); without the id a group of rows sharing one timestamp is
// re-read from its start on every tick.
let parkedCursor: { since: string; sinceId: string } | null = null;

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

type BackgroundSyncRegistration = ServiceWorkerRegistration & {
	sync?: { register(tag: string): Promise<void> };
	periodicSync?: {
		register(tag: string, options: { minInterval: number }): Promise<void>;
	};
};

// Ask the browser to wake the worker when the connection returns, so queued
// operations leave even after the tab was closed. Browsers without the API
// (Safari, Firefox) simply keep the open-window path.
function registerBackgroundSync(): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return;
	}

	void navigator.serviceWorker.ready
		.then((registration) => {
			const sync = (registration as BackgroundSyncRegistration).sync;
			return sync?.register("fastchat-outbox");
		})
		.catch(() => {});
}

// Periodic sync needs an installed application and a permission; where it is
// unsupported or denied the call rejects and the regular sync keeps working.
function registerPeriodicOutboxSync(): void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
		return;
	}

	void navigator.serviceWorker.ready
		.then((registration) => {
			const periodic = (registration as BackgroundSyncRegistration)
				.periodicSync;
			return periodic?.register("fastchat-outbox", {
				minInterval: 15 * 60 * 1000,
			});
		})
		.catch(() => {});
}

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
	navigator.serviceWorker.addEventListener("message", (event) => {
		if ((event.data as { type?: string } | null)?.type === "FASTCHAT_SYNC") {
			scheduleSync();
		}
	});

	registerPeriodicOutboxSync();
}

if (typeof window !== "undefined") {
	// Closing the tab while still online leaves no "online" transition to
	// register the sync on: register it on the way out instead.
	window.addEventListener("pagehide", registerBackgroundSync);
}

export function scheduleSync(): void {
	if (
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		!navigator.onLine
	) {
		registerBackgroundSync();
	}
	if (debounceTimer !== null) clearTimeout(debounceTimer);
	debounceTimer = setTimeout(() => {
		debounceTimer = null;
		void runSync();
	}, debounceMs);
}

function scheduleTransientRetry(retryAfterMs: number | null): void {
	const accountKey = getActiveAccountKey();
	clearRetryTimer();
	retryTimer = setTimeout(() => {
		retryTimer = null;
		// The account may have changed while waiting: do not sync a
		// foreign database with a stale tick.
		if (getActiveAccountKey() !== accountKey) return;
		void runSync();
	}, retryDelayMs(retryAfterMs));
}

export async function runSync(): Promise<void> {
	if (running) {
		scheduled = true;
		return;
	}

	running = true;
	setState("syncing");
	try {
		const outbox = await processOutboxAndPull();
		if (!outbox.completed) {
			// The queue paused on a transient failure. That is not a
			// successful tick: keep the retry timer armed instead of
			// clearing the backoff and leaving the op queued forever.
			lastError = null;
			setState("idle");
			scheduleTransientRetry(outbox.retryAfterMs);
			return;
		}
		lastError = null;
		retryAttempt = 0;
		clearRetryTimer();
		setState("idle");
		// The delta was parked at the continuation (maxSyncRounds): schedule
		// the next tick now, otherwise history stops silently until some
		// unrelated event (SSE, online transition) triggers a sync.
		if (outbox.hasMore === true) scheduleSync();
	} catch (err) {
		if (isTransientSyncError(err)) {
			// Transient failures (429 rate limiting, 5xx, network) must
			// not flip the UI to a permanent "error" state. Back off
			// (honouring Retry-After when present) and retry; the next
			// successful tick clears the state.
			lastError = null;
			setState("idle");
			scheduleTransientRetry(extractRetryAfterMs(err));
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

// SyncTickResult extends the outbox outcome with the delta continuation flag.
type SyncTickResult = OutboxResult & { hasMore?: boolean };

type LockManagerLike = {
	request(
		name: string,
		callback: (lock: unknown) => Promise<SyncTickResult>,
	): Promise<SyncTickResult>;
};

function processOutboxAndPull(): Promise<SyncTickResult> {
	const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
	if (locks !== undefined) {
		const accountKey = getActiveAccountKey();
		return locks.request(`fastchat-sync:${accountKey}`, () =>
			processOutboxAndPullUnlocked(),
		);
	}
	return processOutboxAndPullUnlocked();
}

async function processOutboxAndPullUnlocked(): Promise<SyncTickResult> {
	const token = currentToken();
	if (token === null) return { completed: true, retryAfterMs: null };
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
		return { completed: true, retryAfterMs: null };
	}

	const outbox = await processOutbox(token);
	if (getActiveAccountKey() !== accountKey) {
		return { completed: true, retryAfterMs: null };
	}

	const since = await metaRepo.getLastSyncedAt();
	if (getActiveAccountKey() !== accountKey) {
		return { completed: true, retryAfterMs: null };
	}

	// Page through the delta: one response is bounded server-side, and
	// NextSince points at the continuation. Pages apply as they arrive
	// (bounded memory); every application is idempotent, so the overlap
	// at the cursor is harmless. The persistent cursor advances only when
	// the delta is completely drained; a failure or a closed tab mid-loop
	// must restart from the old cursor, not jump over the continuation.
	const controller = new AbortController();
	inFlightController = controller;
	let cursor: string | null = since;
	let cursorID =
		parkedCursor !== null && parkedCursor.since === since
			? parkedCursor.sinceId
			: "";
	try {
		for (let round = 0; ; round++) {
			const delta = await pullDelta(
				token,
				cursor,
				controller.signal,
				undefined,
				cursorID,
			);
			if (getActiveAccountKey() !== accountKey) {
				return { completed: true, retryAfterMs: null };
			}
			await applyDelta(delta, accountKey);
			if (getActiveAccountKey() !== accountKey) {
				return { completed: true, retryAfterMs: null };
			}
			const next = delta.nextSince ?? null;
			if (next === null) {
				// A complete drain may advance to serverNow. Page-level
				// serverNow would skip the unapplied continuation.
				parkedCursor = null;
				await metaRepo.setLastSyncedAt(delta.serverNow);
				break;
			}
			if (round + 1 >= maxSyncRounds) {
				// Park at the continuation and let the caller schedule the next
				// tick immediately; the boundary tail redelivers idempotently.
				parkedCursor = { since: next, sinceId: delta.nextSinceId ?? "" };
				await metaRepo.setLastSyncedAt(next);
				return {
					completed: outbox.completed,
					retryAfterMs: outbox.retryAfterMs,
					hasMore: true,
				};
			}
			cursor = next;
			cursorID = delta.nextSinceId ?? "";
		}
	} finally {
		if (inFlightController === controller) inFlightController = null;
	}

	// The delta is pulled even when the outbox paused on a transient error:
	// receiving history and reactions must not wait for a rate-limit window.
	return { completed: outbox.completed, retryAfterMs: outbox.retryAfterMs };
}

let tokenProvider: (() => string | null) | null = null;

export function setTokenProvider(fn: () => string | null): void {
	// A token change (account switch/logout) cancels the pending retry and
	// aborts the in-flight fetch so stale ticks never touch the new account.
	inFlightController?.abort();
	inFlightController = null;
	clearRetryTimer();
	retryAttempt = 0;
	// Cursors and tombstones are account-scoped state.
	parkedCursor = null;
	resetLocalTombstones();
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
