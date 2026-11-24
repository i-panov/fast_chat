import { setActiveAccountKey } from "../db/init.ts";
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
export async function runBackgroundOutbox(): Promise<void> {
	const session = await readBackgroundSession();
	if (session === null) return;

	setActiveAccountKey(session.accountKey);
	try {
		const completed = await processOutbox(session.token);
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
		setActiveAccountKey(null);
	}
}
