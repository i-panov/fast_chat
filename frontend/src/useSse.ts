import { useEffect, useRef } from "react";

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

	useEffect(() => {
		onEventRef.current = onEvent;
	}, [onEvent]);

	useEffect(() => {
		if (token === "") {
			return;
		}

		const url = `/api/events?token=${encodeURIComponent(token)}`;
		const source = new EventSource(url);

		source.addEventListener("new_message", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("new_message", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_created", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_created", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_updated", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_updated", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_deleted", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_deleted", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_member_added", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_member_added", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("chat_member_removed", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("chat_member_removed", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("message_updated", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("message_updated", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("message_deleted", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("message_deleted", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("thread_created", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("thread_created", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("thread_message_new", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("thread_message_new", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("typing", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("typing", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("typing_stop", (e) => {
			try {
				const data = JSON.parse(e.data as string) as Record<string, unknown>;
				onEventRef.current("typing_stop", data);
			} catch {
				/* ignore */
			}
		});

		source.addEventListener("connected", () => {
			onEventRef.current("connected", null);
		});

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
