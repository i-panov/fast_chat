import { vi } from "vitest";
import type { createCallManager } from "./callManager.ts";
import type { CallApi } from "./callTypes.ts";

// FakePeerConnection stands in for the connection of the browser: it records
// what the manager asked of it.
export class FakePeerConnection {
	static instances: FakePeerConnection[] = [];

	remoteDescription: unknown = null;
	closed = false;
	addedCandidates: unknown[] = [];
	sent: { sdp: string; type: string }[] = [];
	tracks: unknown[] = [];
	onicecandidate: ((event: { candidate: RTCIceCandidateInit }) => void) | null =
		null;
	ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
	connectionState: string = "new";
	onconnectionstatechange: (() => void) | null = null;

	// setConnectionState moves the fake connection and fires the change
	// handler the manager subscribed, like the browser does.
	setConnectionState(state: string) {
		this.connectionState = state;
		this.onconnectionstatechange?.();
	}

	constructor() {
		FakePeerConnection.instances.push(this);
	}

	createOffer() {
		return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
	}

	createAnswer() {
		return Promise.resolve({ type: "answer", sdp: "answer-sdp" });
	}

	setLocalDescription(desc: { type: string; sdp: string }) {
		this.sent.push(desc);

		return Promise.resolve();
	}

	setRemoteDescription(desc: unknown) {
		this.remoteDescription = desc;

		return Promise.resolve();
	}

	addIceCandidate(candidate: unknown) {
		this.addedCandidates.push(candidate);

		return Promise.resolve();
	}

	addTrack(track: unknown) {
		this.tracks.push(track);
	}

	close() {
		this.closed = true;
	}
}

// fakeApi is the server of the call domain: it answers without a network.
export function fakeApi(overrides: Partial<CallApi> = {}): CallApi {
	return {
		token: "tok",
		getIceServers: vi.fn().mockResolvedValue({ stun: [], turn: [] }),
		startCall: vi.fn().mockResolvedValue({ callId: "c-1", state: "ringing" }),
		acceptCall: vi.fn().mockResolvedValue({ callId: "c-1", state: "active" }),
		rejectCall: vi.fn().mockResolvedValue({ status: "ok" }),
		hangupCall: vi.fn().mockResolvedValue({ status: "ok" }),
		sendCallIce: vi.fn().mockResolvedValue({ status: "ok" }),
		...overrides,
	};
}

// getUserMediaMock is the stub of the camera and the microphone. The tests
// check it directly: a method taken from the navigator is not bound.
export let getUserMediaMock: ReturnType<typeof vi.fn>;

export function stubMedia(stop = vi.fn()) {
	const getUserMedia = vi.fn().mockImplementation(() =>
		Promise.resolve({
			getTracks: () => [{ stop }],
			getAudioTracks: () => [],
			getVideoTracks: () => [],
		}),
	);

	getUserMediaMock = getUserMedia;

	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia,
		},
	});
}

// incoming tells the manager that a call comes in.
export function incoming(manager: ReturnType<typeof createCallManager>) {
	manager.handleIncoming({
		callId: "c-2",
		chatId: "chat-2",
		offer: "offer-sdp",
		from: { id: "bob:test", nick: "bob" },
	});
}
