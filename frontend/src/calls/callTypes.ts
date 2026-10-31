import type {
	CallAcceptedPayload,
	CallIncomingPayload,
	CallRole,
	ICEConfig,
} from "../types/api.ts";

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
	) => Promise<{ callId: string; state: string; iceServers?: ICEConfig }>;
	acceptCall: (
		token: string,
		callId: string,
		answer: string,
	) => Promise<{ callId: string; state: string; iceServers?: ICEConfig }>;
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

// isStringArray tells whether a value is a list of strings.
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((item) => typeof item === "string")
	);
}

// isICEConfig tells whether a value carries ICE servers of the peer. A
// broken federated payload must not break the call: the local servers alone
// still connect calls inside one network.
export function isICEConfig(value: unknown): value is ICEConfig {
	if (!isRecord(value)) return false;
	if (!isStringArray(value.stun)) return false;
	if (!Array.isArray(value.turn)) return false;

	return value.turn.every(
		(turn) =>
			isRecord(turn) &&
			isStringArray(turn.urls) &&
			typeof turn.username === "string" &&
			typeof turn.credential === "string",
	);
}

// isIncomingCallPayload tells whether an event carries a call to take.
export function isIncomingCallPayload(
	data: unknown,
): data is CallIncomingPayload {
	if (!isRecord(data)) return false;
	if (!isNonEmptyString(data.callId)) return false;
	if (typeof data.chatId !== "string") return false;
	if (!isNonEmptyString(data.offer)) return false;
	if (!isRecord(data.from)) return false;
	if (!isNonEmptyString(data.from.id)) return false;
	if (typeof data.from.nick !== "string") return false;

	return data.iceServers == null || isICEConfig(data.iceServers);
}

// isAcceptedCallPayload tells whether an event carries an answer or the news
// that another tab took the call.
export function isAcceptedCallPayload(
	data: unknown,
): data is CallAcceptedPayload {
	if (!isRecord(data)) return false;
	if (!isNonEmptyString(data.callId)) return false;
	if (data.answer !== undefined && !isNonEmptyString(data.answer)) {
		return false;
	}

	return data.iceServers == null || isICEConfig(data.iceServers);
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

// unionIceServers merges the servers of this server with the ones of the
// peer. A federated call needs both relays: each side only reaches its own
// TURN, so the connection is built with the union.
export function unionIceServers(
	local: ICEConfig,
	remote?: ICEConfig,
): RTCIceServer[] {
	return [
		...local.stun.map((url) => ({ urls: url })),
		...(remote?.stun ?? []).map((url) => ({ urls: url })),
		...local.turn.map((turn) => ({
			urls: turn.urls,
			username: turn.username,
			credential: turn.credential,
		})),
		...(remote?.turn ?? []).map((turn) => ({
			urls: turn.urls,
			username: turn.username,
			credential: turn.credential,
		})),
	];
}
