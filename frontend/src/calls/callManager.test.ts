import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallManager } from "./callManager.ts";
import {
	FakePeerConnection,
	fakeApi,
	getUserMediaMock,
	incoming,
	stubMedia,
} from "./callTestUtils.ts";

describe("callManager", () => {
	beforeEach(() => {
		FakePeerConnection.instances = [];
		vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
		stubMedia();
	});

	it("creates an offer and sends it to the server", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		await manager.start("chat-1");

		expect(api.startCall).toHaveBeenCalledWith("tok", "chat-1", "offer-sdp");
		expect(manager.state().phase).toBe("outgoing");
		expect(manager.state().callId).toBe("c-1");
	});

	it("uses the ICE servers of the server", async () => {
		const api = fakeApi({
			getIceServers: vi.fn().mockResolvedValue({
				stun: ["stun:stun.test"],
				turn: [
					{
						urls: ["turn:turn.test"],
						username: "user",
						credential: "secret",
					},
				],
			}),
		});
		const manager = createCallManager(api);

		await manager.start("chat-1");

		expect(api.getIceServers).toHaveBeenCalledWith("tok");
	});

	it("buffers the ICE candidates that arrive before the answer", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);
		manager.handleIce({ candidate: { candidate: "candidate-1" } });

		// The callee has no connection yet: the candidate waits for it.
		expect(FakePeerConnection.instances).toHaveLength(0);

		await manager.accept();

		expect(FakePeerConnection.instances[0].addedCandidates).toEqual([
			{ candidate: "candidate-1" },
		]);
	});

	it("sends the candidates collected before the server answered", async () => {
		let answer: (value: { callId: string; state: string }) => void = () => {};
		const api = fakeApi({
			startCall: vi.fn(
				() =>
					new Promise<{ callId: string; state: string }>((resolve) => {
						answer = resolve;
					}),
			),
		});
		const manager = createCallManager(api);

		const started = manager.start("chat-1");

		await vi.waitFor(() => {
			expect(FakePeerConnection.instances.length).toBeGreaterThan(0);
		});

		// The connection collected a candidate while the request was in
		// flight: it was sent as soon as the identifier was known.
		FakePeerConnection.instances[0].onicecandidate?.({
			candidate: {
				candidate: "late",
				toJSON: () => ({ candidate: "late" }),
			} as unknown as RTCIceCandidate,
		});

		answer({ callId: "c-1", state: "ringing" });
		await started;

		expect(api.sendCallIce).toHaveBeenCalledWith("tok", "c-1", {
			candidate: "late",
		});
	});

	it("waits for the user before taking the call", () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);

		expect(manager.state().phase).toBe("incoming");
		expect(api.acceptCall).not.toHaveBeenCalled();
		expect(getUserMediaMock).not.toHaveBeenCalled();
	});

	it("takes the call when the user accepts it", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);
		await manager.accept();

		expect(api.acceptCall).toHaveBeenCalledWith("tok", "c-2", "answer-sdp");
		expect(manager.state().phase).toBe("active");
	});

	it("releases the media when the call ends", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.end();

		expect(stop).toHaveBeenCalled();
		expect(FakePeerConnection.instances[0].closed).toBe(true);
		expect(manager.state().phase).toBe("idle");
	});

	it("releases the media only once when the call ends twice", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.end();
		manager.end();

		expect(stop).toHaveBeenCalledTimes(1);
	});

	it("releases the media when the server refuses the call", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const api = fakeApi({
			startCall: vi.fn().mockRejectedValue(new Error("http 409: busy")),
		});
		const manager = createCallManager(api);

		await expect(manager.start("chat-1")).rejects.toThrow("http 409");

		expect(stop).toHaveBeenCalled();
		expect(FakePeerConnection.instances[0].closed).toBe(true);
		expect(manager.state().phase).toBe("idle");
	});

	it("rejects the call on the server", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);
		await manager.reject();

		expect(api.rejectCall).toHaveBeenCalledWith("tok", "c-2");
	});

	it("does not send the candidates of a new call to the old one", async () => {
		const resolvers: ((value: { callId: string; state: string }) => void)[] =
			[];
		const api = fakeApi({
			startCall: vi.fn(
				() =>
					new Promise<{ callId: string; state: string }>((resolve) => {
						resolvers.push(resolve);
					}),
			),
		});
		const manager = createCallManager(api);

		const first = manager.start("chat-1");

		await vi.waitFor(() => {
			expect(resolvers.length).toBe(1);
		});

		resolvers[0]({ callId: "c-1", state: "ringing" });
		await first;

		manager.handleEnded({ callId: "c-1", reason: "timeout" });

		const second = manager.start("chat-2");

		await vi.waitFor(() => {
			expect(FakePeerConnection.instances.length).toBe(2);
		});

		// The candidate of the new call is collected before the server
		// answered: it waits for the identifier of the new call.
		FakePeerConnection.instances[1].onicecandidate?.({
			candidate: {
				candidate: "new",
				toJSON: () => ({ candidate: "new" }),
			} as unknown as RTCIceCandidate,
		});

		expect(api.sendCallIce).not.toHaveBeenCalled();

		resolvers[1]({ callId: "c-2", state: "ringing" });
		await second;

		expect(api.sendCallIce).toHaveBeenCalledWith("tok", "c-2", {
			candidate: "new",
		});
	});

	it("does not start a second call while a call is going on", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		await manager.start("chat-1");

		const mediaCalls = getUserMediaMock.mock.calls.length;

		await manager.start("chat-2");

		expect(getUserMediaMock.mock.calls.length).toBe(mediaCalls);
		expect(api.startCall).toHaveBeenCalledTimes(1);
		expect(manager.state().phase).toBe("outgoing");
	});

	it("shows the call before the server answers", async () => {
		const api = fakeApi({
			startCall: vi.fn(
				() => new Promise<{ callId: string; state: string }>(() => {}),
			),
		});
		const manager = createCallManager(api);

		void manager.start("chat-1");

		await vi.waitFor(() => {
			expect(manager.state().phase).toBe("outgoing");
		});
	});

	it("does not take the call twice", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);
		await manager.accept();

		const mediaCalls = getUserMediaMock.mock.calls.length;

		await manager.accept();

		expect(getUserMediaMock.mock.calls.length).toBe(mediaCalls);
		expect(api.acceptCall).toHaveBeenCalledTimes(1);
	});

	it("tells the subscribers about the media of the other side", async () => {
		const manager = createCallManager(fakeApi());
		const listener = vi.fn();

		manager.subscribe(listener);

		await manager.start("chat-1");

		const remote = { id: "remote" } as unknown as MediaStream;

		FakePeerConnection.instances[0].ontrack?.({ streams: [remote] });

		expect(listener).toHaveBeenCalled();
		expect(manager.state().remoteStream).toBe(remote);
	});

	it("tells the subscribers about the microphone and the camera", () => {
		const manager = createCallManager(fakeApi());
		const listener = vi.fn();

		manager.subscribe(listener);

		manager.toggleMute();
		manager.toggleCamera();

		expect(listener).toHaveBeenCalledTimes(2);
		expect(manager.state().muted).toBe(true);
		expect(manager.state().cameraOn).toBe(false);
	});

	it("takes the answer that arrived before the identifier of the call", async () => {
		let answer: (value: { callId: string; state: string }) => void = () => {};
		const api = fakeApi({
			startCall: vi.fn(
				() =>
					new Promise<{ callId: string; state: string }>((resolve) => {
						answer = resolve;
					}),
			),
		});
		const manager = createCallManager(api);

		const started = manager.start("chat-1");

		await vi.waitFor(() => {
			expect(FakePeerConnection.instances.length).toBeGreaterThan(0);
		});

		// The answer of the other side arrives before the answer of the
		// server to the request.
		manager.handleAccepted({ callId: "c-1", answer: "answer-sdp" });

		expect(manager.state().phase).not.toBe("active");

		answer({ callId: "c-1", state: "ringing" });
		await started;

		await vi.waitFor(() => {
			expect(manager.state().phase).toBe("active");
		});

		expect(FakePeerConnection.instances[0].remoteDescription).toEqual({
			type: "answer",
			sdp: "answer-sdp",
		});
	});

	it("keeps the call of the tab that took it", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		incoming(manager);
		const accepting = manager.accept();

		// The server tells the other tabs of the same user that the call was
		// taken. This tab is the one that accepted it.
		manager.handleAccepted({ callId: "c-2" });
		await accepting;

		expect(manager.state().phase).toBe("active");
	});

	it("closes the window when another tab took the call", () => {
		const manager = createCallManager(fakeApi());

		incoming(manager);
		manager.handleAccepted({ callId: "c-2" });

		expect(manager.state().phase).toBe("idle");
	});

	it("mutes and unmutes the microphone", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		expect(manager.state().muted).toBe(false);

		manager.toggleMute();
		expect(manager.state().muted).toBe(true);

		manager.toggleMute();
		expect(manager.state().muted).toBe(false);
	});
});
