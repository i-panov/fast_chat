import { useEffect, useRef } from "react";
import { sseAuth } from "./api.ts";

type EventHandler = (event: string, data: unknown) => void;

function isClosed(source: EventSource): boolean {
	try {
		return source.readyState === EventSource.CLOSED;
	} catch {
		return true;
	}
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
		const source = new EventSource(url);

		function addJSONListener(
			event: string,
			handler: (data: Record<string, unknown>) => void,
		) {
			source.addEventListener(event, (e: MessageEvent) => {
				try {
					handler(JSON.parse(e.data) as Record<string, unknown>);
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
			"thread_created",
			"thread_message_new",
			"typing",
			"typing_stop",
		];

		for (const event of jsonEvents) {
			addJSONListener(event, (data) => onEventRef.current(event, data));
		}

		source.addEventListener("connected", () => {
			onEventRef.current("connected", null);
		});

		source.onopen = () => {
			sseAuth(connectionId, token).catch(() => {
				source.close();
			});
		};

		source.onerror = () => {
			if (isClosed(source)) {
				onEventRef.current("sse_closed", null);
				return;
			}
			onEventRef.current("error", null);
		};

		return () => {
			source.close();
		};
	}, [token]);
}
