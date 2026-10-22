import { useEffect, useRef } from "react";
import { sseAuth } from "./api.ts";

type EventHandler = (event: string, data: unknown) => void | Promise<void>;

const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER_MS = 1000;

// The stream is authenticated by a separate request. A failure of that
// request leaves the stream open but unauthorized, and an unauthorized stream
// delivers no events without ever reporting an error — so the request is
// retried a few times before the stream is dropped and reopened.
const AUTH_RETRY_DELAYS_MS = [0, 200, 500, 1000, 2000];

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isClosed(source: EventSource): boolean {
	try {
		return source.readyState === EventSource.CLOSED;
	} catch {
		return true;
	}
}

function isConnecting(source: EventSource): boolean {
	try {
		return source.readyState === EventSource.CONNECTING;
	} catch {
		return false;
	}
}

function reconnectDelayMs(attempt: number): number {
	const exp = Math.min(
		RECONNECT_MAX_MS,
		RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1),
	);
	// Small random jitter avoids a thundering herd when the server
	// comes back after an outage.
	return exp + Math.random() * RECONNECT_JITTER_MS;
}

export function useSse(token: string, onEvent: EventHandler) {
	const onEventRef = useRef<EventHandler>(onEvent);
	const connectionIdRef = useRef<string>(crypto.randomUUID());

	useEffect(() => {
		onEventRef.current = onEvent;
	}, [onEvent]);

	useEffect(() => {
		if (token === "") {
			return;
		}

		const connectionId = connectionIdRef.current;
		const url = `/api/events?connectionId=${encodeURIComponent(connectionId)}`;
		let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
		let reconnectAttempt = 0;
		let closed = false;
		let currentSource: EventSource | null = null;

		function teardown() {
			closed = true;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			currentSource?.close();
			currentSource = null;
		}

		function scheduleReconnect() {
			if (closed) return;
			if (reconnectTimer !== null) {
				clearTimeout(reconnectTimer);
			}
			reconnectAttempt += 1;
			reconnectTimer = setTimeout(() => {
				reconnectTimer = null;
				open();
			}, reconnectDelayMs(reconnectAttempt));
		}

		function open() {
			if (closed) return;

			currentSource?.close();
			const source = new EventSource(url);
			currentSource = source;

			function addJSONListener(
				event: string,
				handler: (data: Record<string, unknown>) => void,
			) {
				source.addEventListener(event, (e: MessageEvent) => {
					try {
						handler(JSON.parse(e.data as string) as Record<string, unknown>);
					} catch {
						/* ignore */
					}
				});
			}

			const jsonEvents = [
				"new_message",
				"chat_created",
				"chat_updated",
				"chat_deleted",
				"chat_member_added",
				"chat_member_removed",
				"message_updated",
				"message_deleted",
				"message_delivered",
				"message_read",
				"user_status_changed",
				"thread_created",
				"thread_message_new",
				"typing",
				"typing_stop",
				"call_incoming",
				"call_accepted",
				"call_ended",
				"call_ice",
			];

			for (const event of jsonEvents) {
				addJSONListener(event, (data) => {
					void onEventRef.current(event, data);
				});
			}

			source.addEventListener("connected", () => {
				// Ignore events from a superseded socket (e.g. one that was
				// closed by a manual reconnect while a queued event was still
				// being delivered).
				if (source !== currentSource) return;
				// The server sends "connected" as soon as the stream is
				// registered, before the authentication request is answered.
				// The backoff is reset anyway: the stream itself is up.
				reconnectAttempt = 0;
				void onEventRef.current("connected", null);
			});

			source.onopen = () => {
				if (source !== currentSource) return;
				void authenticate(source);
			};

			// authenticate makes the stream usable. A failed attempt is
			// retried a few times: the connection can be established before the
			// server has registered it, and a stream that stays open without
			// authorization delivers nothing and reports no error.
			async function authenticate(source: EventSource) {
				for (const delay of AUTH_RETRY_DELAYS_MS) {
					if (closed || source !== currentSource) return;

					if (delay > 0) {
						await sleep(delay);
					}

					if (closed || source !== currentSource) return;

					try {
						await sseAuth(connectionId, token);
						return;
					} catch (err) {
						if (err instanceof Error && err.message === "unauthorized") {
							// The session is gone: the app logs out through the
							// unauthorized event, retrying would not help.
							break;
						}
					}
				}

				if (closed || source !== currentSource) return;

				// Give up on this stream: close it and let the reconnect logic
				// open a new one. close() fires no error event, so the
				// reconnect is started here.
				source.close();
				void onEventRef.current("sse_closed", null);
				scheduleReconnect();
			}

			source.onerror = () => {
				if (source !== currentSource) return;
				if (isClosed(source)) {
					// CLOSED means the connection is finished — EventSource
					// won't retry on its own (that only happens in CONNECTING
					// state). Notify listeners (e.g. to schedule a sync) and
					// start a manual reconnect with exponential backoff.
					void onEventRef.current("sse_closed", null);
					scheduleReconnect();
					return;
				}
				// In CONNECTING state the browser handles retrying on its
				// own; only surface a transient error to listeners.
				if (isConnecting(source)) {
					return;
				}
				void onEventRef.current("error", null);
			};
		}

		open();

		return () => {
			teardown();
		};
	}, [token]);
}
