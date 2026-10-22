import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallManager } from "./callManager.ts";
import {
	FakePeerConnection,
	fakeApi,
	incoming,
	stubMedia,
} from "./callTestUtils.ts";

describe("callManager endings", () => {
	beforeEach(() => {
		FakePeerConnection.instances = [];
		vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
		stubMedia();
	});

	it("ends the call on the server and reports the reason", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		await manager.start("chat-1");
		await manager.hangup("peer-left");

		expect(api.hangupCall).toHaveBeenCalledWith("tok", "c-1", "peer-left");
		expect(manager.state().phase).toBe("idle");
	});

	it("keeps the reason of the ending", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.handleEnded({ callId: "c-1", reason: "timeout" });

		expect(manager.state().reason).toBe("timeout");
		expect(manager.state().phase).toBe("ended");
	});

	it("remembers which side of the call the user is on", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");

		expect(manager.state().role).toBe("caller");

		incoming(manager);

		expect(manager.state().role).toBe("callee");
	});

	it("closes the notice of the finished call", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.handleEnded({ callId: "c-1", reason: "timeout" });

		manager.dismiss();

		expect(manager.state().phase).toBe("idle");
		expect(manager.state().reason).toBeUndefined();
	});

	it("keeps the notice of a call that is going on", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");

		manager.dismiss();

		expect(manager.state().phase).toBe("outgoing");
	});

	it("releases the media when the peer ends the call", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.handleEnded({ callId: "c-1", reason: "peer-left" });

		expect(stop).toHaveBeenCalled();
		expect(FakePeerConnection.instances[0].closed).toBe(true);
		expect(manager.state().phase).toBe("ended");
	});

	it("ignores the events of another call", async () => {
		const manager = createCallManager(fakeApi());

		await manager.start("chat-1");
		manager.handleEnded({ callId: "other-call", reason: "timeout" });

		expect(manager.state().reason).toBeUndefined();
		expect(manager.state().phase).toBe("outgoing");
	});

	it("releases the media of a call that was replaced", async () => {
		const stop = vi.fn();
		stubMedia(stop);

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
			expect(FakePeerConnection.instances.length).toBe(1);
		});

		// An incoming call takes the place of the call that is being started.
		incoming(manager);
		await manager.accept();

		// The first call releases its own media and its own connection.
		resolvers[0]({ callId: "c-1", state: "ringing" });
		await first;

		expect(stop).toHaveBeenCalledTimes(1);
		expect(FakePeerConnection.instances[0].closed).toBe(true);
	});

	it("ends the call on the server when the user hangs up while it starts", async () => {
		const stop = vi.fn();
		stubMedia(stop);

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

		const started = manager.start("chat-1");

		await vi.waitFor(() => {
			expect(resolvers.length).toBe(1);
		});

		// The user ends the call before the server answered.
		await manager.hangup("hangup");

		expect(manager.state().phase).toBe("idle");
		expect(stop).toHaveBeenCalled();

		resolvers[0]({ callId: "c-1", state: "ringing" });
		await started;

		// The server knows the call now: it must not ring until the window
		// runs out.
		expect(api.hangupCall).toHaveBeenCalledWith("tok", "c-1", "hangup");
	});

	it("does not ask the server for a call that was ended before the request", async () => {
		let giveMedia: () => void = () => {};
		const getUserMedia = vi.fn(
			() =>
				new Promise((resolve) => {
					giveMedia = () =>
						resolve({
							getTracks: () => [{ stop: vi.fn() }],
							getAudioTracks: () => [],
							getVideoTracks: () => [],
						});
				}),
		);

		vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

		const api = fakeApi();
		const manager = createCallManager(api);

		const started = manager.start("chat-1");

		await vi.waitFor(() => {
			expect(getUserMedia).toHaveBeenCalled();
		});

		// The user ends the call while the camera is being asked for.
		await manager.hangup("hangup");

		giveMedia();
		await started;

		expect(api.startCall).not.toHaveBeenCalled();
		expect(api.hangupCall).not.toHaveBeenCalled();
	});

	it("does nothing when there is no call to end", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);
		const listener = vi.fn();

		manager.subscribe(listener);

		await manager.hangup("hangup");

		expect(api.hangupCall).not.toHaveBeenCalled();
		expect(manager.state().reason).toBeUndefined();
		expect(manager.state().phase).toBe("idle");
		expect(listener).not.toHaveBeenCalled();
	});

	it("does nothing when the call is already over", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		await manager.start("chat-1");
		manager.handleEnded({ callId: "c-1", reason: "peer-left" });

		const listener = vi.fn();
		manager.subscribe(listener);

		await manager.hangup("hangup");

		expect(api.hangupCall).not.toHaveBeenCalled();
		expect(manager.state().reason).toBe("peer-left");
		expect(manager.state().phase).toBe("ended");
		expect(listener).not.toHaveBeenCalled();
	});

	it("does not reject a call that is already over", async () => {
		const api = fakeApi();
		const manager = createCallManager(api);

		await manager.start("chat-1");
		manager.handleEnded({ callId: "c-1", reason: "timeout" });

		const listener = vi.fn();
		manager.subscribe(listener);

		await manager.reject();

		expect(api.rejectCall).not.toHaveBeenCalled();
		expect(manager.state().reason).toBe("timeout");
		expect(manager.state().phase).toBe("ended");
		expect(listener).not.toHaveBeenCalled();
	});
});
