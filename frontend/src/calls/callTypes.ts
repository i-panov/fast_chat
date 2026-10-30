import type { CallRole, ICEConfig } from "../types/api.ts";

// CallPhase is the phase of the call the user is in.
export type CallPhase = "idle" | "outgoing" | "incoming" | "active" | "ended";

// CallView is the state of the call the interface renders.
export interface CallView {
	phase: CallPhase;
	role?: CallRole;
	callId?: string;
	chatId?: string;
	peerId?: string;
	peerNick?: string;
	// reason is why the last call ended: the other side did not answer, it
	// disconnected, or it hung up.
	reason?: string;
	localStream?: MediaStream;
	remoteStream?: MediaStream;
	muted: boolean;
	cameraOn: boolean;
}

// CallApi is the part of the server the manager talks to.
export interface CallApi {
	token: string;
	// getIceServers returns the STUN and TURN servers of the server. Without
	// them the call only connects inside one network.
	getIceServers: (token: string) => Promise<ICEConfig>;
	startCall: (
		token: string,
		chatId: string,
		offer: string,
	) => Promise<{ callId: string; state: string }>;
	acceptCall: (
		token: string,
		callId: string,
		answer: string,
	) => Promise<{ callId: string; state: string }>;
	rejectCall: (token: string, callId: string) => Promise<{ status: string }>;
	hangupCall: (
		token: string,
		callId: string,
		reason?: string,
	) => Promise<{ status: string }>;
	sendCallIce: (
		token: string,
		callId: string,
		candidate: RTCIceCandidateInit,
	) => Promise<{ status: string }>;
}

// isRecord guards a signaling payload: a broken event must not throw inside
// the SSE handler.
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

// isIncomingCallPayload tells whether an event carries a call to take.
export function isIncomingCallPayload(data: unknown): boolean {
	if (!isRecord(data)) return false;
	if (!isNonEmptyString(data.callId)) return false;
	if (typeof data.chatId !== "string") return false;
	if (!isNonEmptyString(data.offer)) return false;
	if (!isRecord(data.from)) return false;

	return isNonEmptyString(data.from.id) && typeof data.from.nick === "string";
}

// isAcceptedCallPayload tells whether an event carries an answer or the news
// that another tab took the call.
export function isAcceptedCallPayload(data: unknown): boolean {
	if (!isRecord(data)) return false;
	if (!isNonEmptyString(data.callId)) return false;
	if (data.answer === undefined) return true;

	return isNonEmptyString(data.answer);
}

// isEndedCallPayload tells whether an event can be matched to a call.
export function isEndedCallPayload(data: unknown): boolean {
	return isRecord(data) && isNonEmptyString(data.callId);
}

// isIceCallPayload tells whether an event carries a candidate.
export function isIceCallPayload(data: unknown): boolean {
	if (!isRecord(data)) return false;

	return (
		isRecord(data.candidate) &&
		(data.callId === undefined || typeof data.callId === "string")
	);
}
