import { vi } from "vitest";
import type { createCallManager } from "./callManager.ts";
import type { CallApi } from "./callTypes.ts";

// FakePeerConnection stands in for the connection of the browser: it records
// what the manager asked of it.
export class FakePeerConnection {
	static instances: FakePeerConnection[] = [];

	// config records the configuration the manager built the connection
	// with: the tests check that both relays made it into it.
	config?: RTCConfiguration;
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

	constructor(config?: RTCConfiguration) {
		this.config = config;
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

// FakeTrack is a media track of the fake stream. The manager toggles
// `enabled`; the tests inspect it, because a flag alone hides the
// "muted but the microphone still transmits" bug.
export interface FakeTrack {
	kind: "audio" | "video";
	enabled: boolean;
	stop: () => void;
}

export interface FakeStream extends MediaStream {
	audioTrack: FakeTrack;
	videoTrack: FakeTrack;
}

// fakeStream builds a stream with real-looking audio and video tracks.
export function fakeStream(stop: () => void = () => {}): FakeStream {
	const audioTrack: FakeTrack = { kind: "audio", enabled: true, stop };
	const videoTrack: FakeTrack = { kind: "video", enabled: true, stop };
	const tracks = [audioTrack, videoTrack];
	const stream = {
		audioTrack,
		videoTrack,
		getTracks: () => tracks,
		getAudioTracks: () => [audioTrack],
		getVideoTracks: () => [videoTrack],
		addTrack: () => {},
		removeTrack: () => {},
	} as unknown as FakeStream;

	return stream;
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

export function stubMedia(stop = vi.fn()): FakeStream {
	const stream = fakeStream(stop);
	const getUserMedia = vi
		.fn()
		.mockImplementation(() => Promise.resolve(stream));

	getUserMediaMock = getUserMedia;

	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia,
		},
	});

	return stream;
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
