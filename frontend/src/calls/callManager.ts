import type { ICEConfig } from "../types/api.ts";
import type { CallApi, CallPhase, CallView } from "./callTypes.ts";

const MEDIA_CONSTRAINTS: MediaStreamConstraints = {
	audio: true,
	video: true,
};

const AUDIO_ONLY_CONSTRAINTS: MediaStreamConstraints = { audio: true };

// CallManager owns the peer connection and the media of a call. The
// interface never touches WebRTC directly: it asks the manager to start,
// accept or end a call and reads the state it keeps.
//
// The user accepts a call himself: the manager only remembers the incoming
// call until then.
export interface CallManager {
	// start begins a call in a chat. It does nothing when a call is already
	// going on: the user must end it first.
	start(chatId: string): Promise<void>;
	accept(): Promise<void>;
	// reject declines an incoming call.
	reject(): Promise<void>;
	// hangup ends the call for both sides. It works while the call is still
	// being established: the server is told as soon as it answers.
	hangup(reason?: string): Promise<void>;
	handleIncoming(payload: unknown): void;
	handleAccepted(payload: unknown): void;
	handleEnded(payload: unknown): void;
	handleIce(payload: unknown): void;
	toggleMute(): void;
	toggleCamera(): void;
	// end stops the call on this side: it releases the media and the
	// connection, but it does not tell the server. Use hangup to end the
	// call for both sides.
	end(): void;
	state(): CallView;
	subscribe(listener: () => void): () => void;
}

// CallContext is the state of the call the manager keeps: the connection, the
// media and the phase.
interface CallContext {
	phase: CallPhase;
	callId?: string;
	chatId?: string;
	peerId?: string;
	peerNick?: string;
	// pendingOffer is the description of the incoming call. It waits for the
	// user to accept it.
	pendingOffer?: string;
	// accepting tells that this tab is the one that accepted the call: the
	// server tells the other tabs of the same user too, and they must not
	// take the call for themselves.
	accepting: boolean;
	// reason is why the last call ended. It survives the end of the call, so
	// the interface can report it.
	reason?: string;
	localStream?: MediaStream;
	remoteStream?: MediaStream;
	peer?: RTCPeerConnection;
	// remoteReady tells whether the connection knows the description of the
	// other side: a candidate that arrives earlier waits for it.
	remoteReady: boolean;
	pendingCandidates: RTCIceCandidateInit[];
	// pendingAnswer is the answer of the other side. It can arrive before
	// the client knows the identifier of the call, so it waits for it.
	pendingAnswer?: { callId: string; sdp: string };
	// outgoingCandidates are the candidates of the caller, collected before
	// the server answered with the identifier of the call.
	outgoingCandidates: RTCIceCandidateInit[];
	muted: boolean;
	cameraOn: boolean;
	iceServers: RTCIceServer[];
	// generation invalidates the running operations: every start and every
	// incoming call begins a new one, so a late answer does not touch the
	// call that replaced it.
	generation: number;
}

export function createCallManager(
	api: CallApi,
	initialIceServers: RTCIceServer[] = [],
): CallManager {
	const ctx: CallContext = {
		phase: "idle",
		accepting: false,
		remoteReady: false,
		pendingCandidates: [],
		outgoingCandidates: [],
		muted: false,
		cameraOn: true,
		iceServers: initialIceServers,
		generation: 0,
	};

	const listeners = new Set<() => void>();

	function notify() {
		for (const listener of listeners) {
			listener();
		}
	}

	// endCall closes the call: the running operations must not touch it any
	// more, and the media is released.
	const endCall = () => {
		ctx.generation += 1;
		releaseMedia(ctx);
		resetContext(ctx);
		notify();
	};

	return {
		start: (chatId: string) => startCall(ctx, api, chatId, notify),

		accept: () => acceptIncomingCall(ctx, api, notify),

		async reject() {
			// Only a call that waits for the answer can be rejected. A call
			// that is over keeps its reason and its phase.
			if (ctx.phase !== "incoming" || ctx.callId === undefined) return;

			const callId = ctx.callId;
			ctx.reason = "rejected";

			try {
				await api.rejectCall(api.token, callId);
			} finally {
				endCall();
			}
		},

		async hangup(reason?: string) {
			// A call that was never there or is already over: there is
			// nothing to end, and nothing to report.
			if (ctx.phase === "idle" || ctx.phase === "ended") return;

			// The call is still being established: the server does not know
			// it yet. The end is remembered: as soon as the server answers,
			// the call is ended there too, or the other side rings until the
			// window runs out.
			if (ctx.callId === undefined) {
				ctx.reason = reason ?? "hangup";
				endCall();

				return;
			}

			const callId = ctx.callId;
			ctx.reason = reason ?? "hangup";

			try {
				await api.hangupCall(api.token, callId, reason);
			} finally {
				endCall();
			}
		},

		handleIncoming(payload: unknown) {
			const data = payload as {
				callId: string;
				chatId: string;
				offer: string;
				from: { id: string; nick: string };
			};

			// The call waits for the user: the media is only asked for when
			// he accepts it.
			ctx.callId = data.callId;
			ctx.chatId = data.chatId;
			ctx.peerId = data.from.id;
			ctx.peerNick = data.from.nick;
			ctx.pendingOffer = data.offer;
			ctx.phase = "incoming";
			ctx.pendingCandidates = [];
			ctx.reason = undefined;
			notify();
		},

		handleAccepted(payload: unknown) {
			const data = payload as { callId: string; answer?: string };

			if (data.answer === undefined) {
				// The call was taken. When this tab is the one that accepted
				// it, the answer is on its way: nothing to do. When another
				// tab took it, this one closes its window.
				if (!ctx.accepting && ctx.phase === "incoming") {
					ctx.reason = "taken-elsewhere";
					endCall();
				}

				return;
			}

			// The answer belongs to the caller. It waits for the call it
			// belongs to: the answer can arrive before the client learned
			// the identifier of the call.
			ctx.pendingAnswer = { callId: data.callId, sdp: data.answer };

			applyPendingAnswer(ctx, notify);
		},

		handleEnded(payload: unknown) {
			const data = payload as { callId?: string; reason?: string };

			if (!belongsToCall(ctx, data.callId)) return;

			// The call is over: the media is released, but the phase and
			// the reason stay, so the interface can report how it ended.
			ctx.generation += 1;
			ctx.accepting = false;
			ctx.pendingAnswer = undefined;
			releaseMedia(ctx);
			ctx.reason = data.reason;
			ctx.phase = "ended";
			notify();
		},

		handleIce(payload: unknown) {
			const data = payload as {
				callId?: string;
				candidate: RTCIceCandidateInit;
			};

			if (!belongsToCall(ctx, data.callId)) return;

			// A candidate can arrive before the description it belongs to.
			// It waits until the connection is ready.
			if (!ctx.peer || !ctx.remoteReady) {
				ctx.pendingCandidates.push(data.candidate);

				return;
			}

			void ctx.peer.addIceCandidate(data.candidate);
		},

		toggleMute() {
			ctx.muted = !ctx.muted;

			for (const track of ctx.localStream?.getAudioTracks() ?? []) {
				track.enabled = !ctx.muted;
			}

			notify();
		},

		toggleCamera() {
			ctx.cameraOn = !ctx.cameraOn;

			for (const track of ctx.localStream?.getVideoTracks() ?? []) {
				track.enabled = ctx.cameraOn;
			}

			notify();
		},

		end: endCall,

		state() {
			return {
				phase: ctx.phase,
				callId: ctx.callId,
				chatId: ctx.chatId,
				peerId: ctx.peerId,
				peerNick: ctx.peerNick,
				reason: ctx.reason,
				localStream: ctx.localStream,
				remoteStream: ctx.remoteStream,
				muted: ctx.muted,
				cameraOn: ctx.cameraOn,
			};
		},

		subscribe(listener: () => void) {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
	};
}

// belongsToCall tells whether an event belongs to the call the manager
// follows. The events of another call must not touch the current one.
function belongsToCall(ctx: CallContext, callID?: string): boolean {
	if (ctx.callId === undefined) return false;

	return callID === undefined || callID === ctx.callId;
}

// stopStream stops the tracks of a stream the call does not use.
function stopStream(stream?: MediaStream) {
	for (const track of stream?.getTracks() ?? []) {
		track.stop();
	}
}

// releaseMedia stops the camera and the microphone and closes the
// connection. The state of the call stays, so the interface can report how
// it ended.
function releaseMedia(ctx: CallContext) {
	stopStream(ctx.localStream);

	ctx.peer?.close();
	ctx.localStream = undefined;
	ctx.remoteStream = undefined;
	ctx.peer = undefined;
	ctx.remoteReady = false;
}

// resetContext forgets the call. The reason of the last ending stays.
function resetContext(ctx: CallContext) {
	ctx.phase = "idle";
	ctx.callId = undefined;
	ctx.chatId = undefined;
	ctx.peerId = undefined;
	ctx.peerNick = undefined;
	ctx.pendingOffer = undefined;
	ctx.accepting = false;
	ctx.pendingCandidates = [];
	ctx.pendingAnswer = undefined;
	ctx.outgoingCandidates = [];
	ctx.muted = false;
	ctx.cameraOn = true;
}

// startCall asks the server for a call and offers the local media. When the
// server refuses the call, the media and the connection are released.
//
// A call that is already going on is not replaced: the media and the
// connection of the old call would keep the camera busy, and the server
// refuses a second call anyway.
async function startCall(
	ctx: CallContext,
	api: CallApi,
	chatId: string,
	notify: () => void,
): Promise<void> {
	if (
		ctx.phase === "incoming" ||
		ctx.phase === "outgoing" ||
		ctx.phase === "active"
	) {
		return;
	}

	const generation = ctx.generation + 1;
	ctx.generation = generation;
	ctx.accepting = false;
	ctx.reason = undefined;

	// The state of the previous call must not leak into the new one: the
	// identifier of the old call would send the new candidates to it.
	ctx.callId = undefined;
	ctx.pendingOffer = undefined;
	ctx.pendingAnswer = undefined;
	ctx.pendingCandidates = [];
	ctx.outgoingCandidates = [];

	// The call starts before the first wait: the interface must see that the
	// call is on and must not offer a second one.
	ctx.phase = "outgoing";
	notify();

	// The stream and the connection belong to this call only: they are
	// released on their own when another call takes over.
	let stream: MediaStream | undefined;
	let peer: RTCPeerConnection | undefined;

	try {
		ctx.iceServers = await loadIceServers(api);
		stream = await acquireMedia();

		if (ctx.generation !== generation) {
			stopStream(stream);

			return;
		}

		ctx.localStream = stream;
		peer = createPeer(ctx, api, notify);
		ctx.peer = peer;
		attachLocalTracks(peer, stream);

		const offer = await peer.createOffer();
		await peer.setLocalDescription(offer);

		const result = await api.startCall(api.token, chatId, offer.sdp ?? "");

		if (ctx.generation !== generation) {
			// The call is not wanted anymore: the server must end it too,
			// or the other side rings until the window runs out.
			stopStream(stream);
			peer?.close();

			await endCallOnServer(api, result.callId);

			return;
		}

		ctx.callId = result.callId;
		ctx.chatId = chatId;
		await flushOutgoingCandidates(ctx, api);
		applyPendingAnswer(ctx, notify);
		notify();
	} catch (err) {
		if (ctx.generation !== generation) {
			// The call was ended or replaced while the request was in
			// flight: there is nothing to report.
			stopStream(stream);
			peer?.close();

			return;
		}

		releaseMedia(ctx);
		resetContext(ctx);
		notify();

		throw err;
	}
}

// acceptIncomingCall takes the call the user agreed to: it answers the offer
// and tells the server about it. The media is only asked for here, and it is
// released when the server refuses the call.
async function acceptIncomingCall(
	ctx: CallContext,
	api: CallApi,
	notify: () => void,
): Promise<void> {
	// Only a call that waits for the user can be taken. A second call of
	// accept() must not ask for the media again.
	if (ctx.phase !== "incoming" || ctx.accepting) return;
	if (ctx.callId === undefined || ctx.pendingOffer === undefined) return;

	const generation = ctx.generation + 1;
	ctx.generation = generation;
	const callId = ctx.callId;
	const offer = ctx.pendingOffer;

	// The server tells the other tabs of the same user that the call was
	// taken. The flag is set before the first await, because the event can
	// arrive while this tab is still preparing the answer.
	ctx.accepting = true;

	let stream: MediaStream | undefined;
	let peer: RTCPeerConnection | undefined;

	try {
		stream = await acquireMedia();

		if (ctx.generation !== generation) {
			stopStream(stream);

			return;
		}

		ctx.localStream = stream;
		peer = createPeer(ctx, api, notify);
		ctx.peer = peer;
		attachLocalTracks(peer, stream);

		await peer.setRemoteDescription({ type: "offer", sdp: offer });
		ctx.remoteReady = true;
		await flushPendingCandidates(ctx);

		const answer = await peer.createAnswer();
		await peer.setLocalDescription(answer);

		await api.acceptCall(api.token, callId, answer.sdp ?? "");

		if (ctx.generation !== generation) {
			// The call ended while the answer was prepared: this call
			// releases its own media and its own connection.
			stopStream(stream);
			peer?.close();

			return;
		}

		ctx.pendingOffer = undefined;
		ctx.phase = "active";
		notify();
	} catch (err) {
		if (ctx.generation !== generation) {
			// The call ended while the answer was prepared: there is
			// nothing to report.
			stopStream(stream);
			peer?.close();

			return;
		}

		releaseMedia(ctx);
		resetContext(ctx);
		notify();

		throw err;
	} finally {
		if (ctx.generation === generation) {
			ctx.accepting = false;
		}
	}
}

// endCallOnServer ends the call the server created. The call may be gone
// already: then there is nothing to end.
async function endCallOnServer(api: CallApi, callID: string) {
	try {
		await api.hangupCall(api.token, callID, "hangup");
	} catch {
		// The call is over on the server side already.
		return;
	}
}

// createPeer builds the connection and wires the events it reports.
function createPeer(
	ctx: CallContext,
	api: CallApi,
	notify: () => void,
): RTCPeerConnection {
	const connection = new RTCPeerConnection({ iceServers: ctx.iceServers });

	connection.onicecandidate = (event) => {
		if (!event.candidate) return;

		// The identifier of the call is only known after the server
		// answered, so the candidates collected in the meantime wait for it.
		if (ctx.callId === undefined) {
			ctx.outgoingCandidates.push(event.candidate.toJSON());

			return;
		}

		void api.sendCallIce(api.token, ctx.callId, event.candidate.toJSON());
	};

	connection.ontrack = (event) => {
		ctx.remoteStream = event.streams[0];
		notify();
	};

	return connection;
}

// loadIceServers reads the servers of the server. Without them the call only
// connects inside one network.
async function loadIceServers(api: CallApi): Promise<RTCIceServer[]> {
	try {
		const config: ICEConfig = await api.getIceServers(api.token);

		return [
			...config.stun.map((url) => ({ urls: url })),
			...config.turn.map((turn) => ({
				urls: turn.urls,
				username: turn.username,
				credential: turn.credential,
			})),
		];
	} catch {
		return [];
	}
}

// acquireMedia asks for the camera and the microphone. A device without a
// camera still talks.
async function acquireMedia(): Promise<MediaStream> {
	try {
		return await navigator.mediaDevices.getUserMedia(MEDIA_CONSTRAINTS);
	} catch {
		return await navigator.mediaDevices.getUserMedia(AUDIO_ONLY_CONSTRAINTS);
	}
}

// attachLocalTracks puts the microphone and the camera into the connection.
function attachLocalTracks(peer: RTCPeerConnection, stream: MediaStream) {
	for (const track of stream.getTracks()) {
		peer.addTrack(track, stream);
	}
}

// applyAnswer takes the description of the other side and hands it the
// candidates that arrived before it.
async function applyAnswer(ctx: CallContext, answer: string) {
	if (!ctx.peer) return;

	await ctx.peer.setRemoteDescription({ type: "answer", sdp: answer });
	ctx.remoteReady = true;

	await flushPendingCandidates(ctx);
}

// applyPendingAnswer hands the answer to the connection of the caller. The
// answer of a call the manager does not follow is ignored.
function applyPendingAnswer(ctx: CallContext, notify: () => void) {
	const pending = ctx.pendingAnswer;
	if (pending === undefined) return;
	if (ctx.phase !== "outgoing" || ctx.callId !== pending.callId) return;
	if (!ctx.peer) return;

	ctx.pendingAnswer = undefined;

	void (async () => {
		await applyAnswer(ctx, pending.sdp);
		ctx.phase = "active";
		notify();
	})();
}

// flushPendingCandidates hands the connection the candidates that arrived
// before the description of the other side.
async function flushPendingCandidates(ctx: CallContext) {
	if (!ctx.peer) return;

	for (const candidate of ctx.pendingCandidates) {
		await ctx.peer.addIceCandidate(candidate);
	}

	ctx.pendingCandidates = [];
}

// flushOutgoingCandidates sends the candidates the caller collected before the
// server answered with the identifier of the call.
async function flushOutgoingCandidates(ctx: CallContext, api: CallApi) {
	if (ctx.callId === undefined) return;

	for (const candidate of ctx.outgoingCandidates) {
		await api.sendCallIce(api.token, ctx.callId, candidate);
	}

	ctx.outgoingCandidates = [];
}
