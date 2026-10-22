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
