import type { CallManager } from "./callManager.ts";

// handleCallEvent routes a signaling event to the manager. The unknown
// events are ignored: the stream carries the whole domain.
export function handleCallEvent(
	manager: CallManager,
	event: string,
	data: unknown,
): void {
	switch (event) {
		case "call_incoming":
			manager.handleIncoming(data);
			return;
		case "call_accepted":
			manager.handleAccepted(data);
			return;
		case "call_ended":
			manager.handleEnded(data);
			return;
		case "call_ice":
			manager.handleIce(data);
			return;
		default:
			return;
	}
}
