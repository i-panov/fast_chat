import type { CallApi } from "./callTypes.ts";
import type { CallContext } from "./callManager.ts";

// DISCONNECT_GRACE_MS is how long a transient "disconnected" connection
// may recover before the call is ended (locally and on the server).
export const DISCONNECT_GRACE_MS = 10_000;

// endRemoteCall tells the server the call is over without touching the
// local state: best-effort, for paths (dead connection) where hangup()
// refuses to run because the phase is already over.
export function endRemoteCall(ctx: CallContext, api: CallApi) {
	if (ctx.callId === undefined) return;
	const callId = ctx.callId;
	void api.hangupCall(api.token, callId, "peer-left").catch(() => undefined);
}

// settleEnded reports the end of the call: the media is released, but the
// phase and the reason stay, so the interface can report how it ended.
export function settleEnded(
	ctx: CallContext,
	notify: () => void,
	ending: Record<string, unknown>,
) {
	ctx.generation += 1;
	ctx.accepting = false;
	releaseMedia(ctx);
	// The identifier stays with the ending: a page that learns about
	// a missed call on start reports it once, and the identifier is
	// what tells the same call from the next one.
	if (ctx.callId === undefined && typeof ending.callId === "string") {
		ctx.callId = ending.callId;
	}
	if (typeof ending.peerId === "string") ctx.peerId = ending.peerId;
	if (ending.role === "caller" || ending.role === "callee") {
		ctx.role = ending.role;
	}
	ctx.reason = typeof ending.reason === "string" ? ending.reason : undefined;
	ctx.phase = "ended";
	notify();
}

// stopStream stops the tracks of a stream the call does not use.
export function stopStream(stream?: MediaStream) {
	for (const track of stream?.getTracks() ?? []) {
		track.stop();
	}
}

// releaseMedia stops the camera and the microphone and closes the
// connection. The state of the call stays, so the interface can report how
// it ended. The queues of the call are cleared too: they belong to the old
// connection and must not reach the next one.
export function releaseMedia(ctx: CallContext) {
	if (ctx.disconnectTimer !== undefined) {
		clearTimeout(ctx.disconnectTimer);
		ctx.disconnectTimer = undefined;
	}
	stopStream(ctx.localStream);
	stopStream(ctx.remoteStream);

	ctx.peer?.close();
	ctx.localStream = undefined;
	ctx.remoteStream = undefined;
	ctx.peer = undefined;
	ctx.remoteReady = false;
	ctx.pendingCandidates = [];
	ctx.outgoingCandidates = [];
	ctx.pendingOffer = undefined;
	ctx.pendingAnswer = undefined;
}
