import { useEffect, useRef } from "react";

type EventHandler = (event: string, data: unknown) => void;

function isClosed(source: EventSource): boolean {
  try {
    return source.readyState === EventSource.CLOSED;
  } catch {
    return true;
  }
}

export function useSSE(token: string, onEvent: EventHandler) {
  const onEventRef = useRef<EventHandler>(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (token === "") { return; }

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

    return () => { source.close(); };
  }, [token]);
}
