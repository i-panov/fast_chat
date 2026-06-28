import { metaRepo } from "../db/metaRepo.ts";
import { applyDelta, pullDelta } from "./deltaApplier.ts";
import { processOutbox } from "./outboxProcessor.ts";

export type SyncState = "idle" | "syncing" | "error";

type Listener = (state: SyncState) => void;

const listeners = new Set<Listener>();
let currentState: SyncState = "idle";
let lastError: unknown = null;

let running = false;
let scheduled = false;
const debounceMs = 1000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

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
		setState("idle");
	} catch (err) {
		lastError = err;
		setState("error");
	} finally {
		running = false;
		if (scheduled) {
			scheduled = false;
			void runSync();
		}
	}
}

async function processOutboxAndPull(): Promise<void> {
	const token = currentToken();
	if (token === null) return;

	if (typeof navigator !== "undefined" && !navigator.onLine) {
		// Offline: don't try to push or pull. The next online tick
		// will reschedule.
		return;
	}

	await processOutbox(token);

	const since = await metaRepo.getLastSyncedAt();
	const delta = await pullDelta(token, since);
	await applyDelta(delta);
}

let tokenProvider: (() => string | null) | null = null;

export function setTokenProvider(fn: () => string | null): void {
	tokenProvider = fn;
}

function currentToken(): string | null {
	return tokenProvider?.() ?? null;
}
