import { getActiveAccountKey, setActiveAccountKey } from "../db/init.ts";
import {
	clearBackgroundSession,
	readBackgroundSession,
} from "./backgroundSession.ts";
import { processOutbox } from "./outboxProcessor.ts";

function isUnauthorized(error: unknown): boolean {
	return (
		error instanceof Error && error.message.toLowerCase() === "unauthorized"
	);
}

/**
 * Runs the queued operations from the Service Worker, without a window.
 *
 * The operations are already prepared for sending when they are enqueued
 * (including the encrypted payload and the staged blobs), so the worker needs
 * only the token of the active account and the account's IndexedDB.
 *
 * A transient failure is rethrown: the browser then retries the Background
 * Sync event with its own backoff. An expired session is not retried, because
 * the same token will never work again; the credentials are dropped and the
 * application mirrors fresh ones on the next login.
 */
// Background Sync events may overlap: a second one can start while the first
// is still awaiting the network. Both mutate the process-wide active account,
// so they run one after another instead of interleaving their IDB writes.
let runQueue: Promise<void> = Promise.resolve();

export function runBackgroundOutbox(): Promise<void> {
	const run = runQueue.then(() => runBackgroundOutboxLocked());
	// Keep the queue alive after a rejection: the next event still runs.
	runQueue = run.catch(() => undefined);
	return run;
}

async function runBackgroundOutboxLocked(): Promise<void> {
	const session = await readBackgroundSession();
	if (session === null) return;

	const previousAccount = getActiveAccountKey();
	setActiveAccountKey(session.accountKey);
	try {
		const { completed } = await processOutbox(session.token);
		if (!completed) {
			// The browser retries a rejected sync event with its own backoff;
			// a resolved one would drop the queue until the next launch.
			throw new Error("background outbox paused by a transient failure");
		}
	} catch (error) {
		if (isUnauthorized(error)) {
			await clearBackgroundSession();
			return;
		}

		throw error;
	} finally {
		setActiveAccountKey(previousAccount);
	}
}
