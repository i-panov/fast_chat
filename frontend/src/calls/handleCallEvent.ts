import type { CallManager } from "./callManager.ts";
import {
	isAcceptedCallPayload,
	isEndedCallPayload,
	isIceCallPayload,
	isIncomingCallPayload,
} from "./callTypes.ts";

// handleCallEvent routes a signaling event to the manager. The unknown
// events are ignored: the stream carries the whole domain.
export function handleCallEvent(
	manager: CallManager,
	event: string,
	data: unknown,
): void {
	switch (event) {
		case "call_incoming":
			if (!isIncomingCallPayload(data)) return;
			manager.handleIncoming(data);
			return;
		case "call_accepted":
			if (!isAcceptedCallPayload(data)) return;
			manager.handleAccepted(data);
			return;
		case "call_ended":
			if (!isEndedCallPayload(data)) return;
			manager.handleEnded(data);
			return;
		case "call_ice":
			if (!isIceCallPayload(data)) return;
			manager.handleIce(data);
			return;
		default:
			return;
	}
}
