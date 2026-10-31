import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCallManager } from "./callManager.ts";
import { FakePeerConnection, fakeApi, stubMedia } from "./callTestUtils.ts";

// serverUrls flattens the servers of a connection into plain urls.
function serverUrls(peer: FakePeerConnection): string[] {
	const servers = peer.config?.iceServers ?? [];

	return servers.flatMap((server) =>
		Array.isArray(server.urls) ? server.urls : [server.urls],
	);
}

describe("federated ice union", () => {
	beforeEach(() => {
		FakePeerConnection.instances = [];
		vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
		stubMedia();
	});

	it("merges local and remote ice servers", async () => {
		const api = fakeApi({
			getIceServers: vi.fn().mockResolvedValue({ stun: ["stun:a"], turn: [] }),
		});
		const manager = createCallManager(api);

		manager.handleIncoming({
			callId: "c-fed",
			chatId: "chat-fed",
			offer: "offer-sdp",
			from: { id: "bob:remote.test", nick: "bob" },
			iceServers: { stun: ["stun:b"], turn: [] },
		});

		await manager.accept();

		expect(manager.state().phase).toBe("active");
		expect(FakePeerConnection.instances).toHaveLength(1);

		const urls = serverUrls(FakePeerConnection.instances[0]);

		expect(urls).toContain("stun:a");
		expect(urls).toContain("stun:b");
	});

	it("falls back to local servers without remote ice", async () => {
		const api = fakeApi({
			getIceServers: vi.fn().mockResolvedValue({ stun: ["stun:a"], turn: [] }),
		});
		const manager = createCallManager(api);

		manager.handleIncoming({
			callId: "c-local",
			chatId: "chat-local",
			offer: "offer-sdp",
			from: { id: "bob:localhost:8080", nick: "bob" },
		});

		await manager.accept();

		expect(manager.state().phase).toBe("active");

		const urls = serverUrls(FakePeerConnection.instances[0]);

		expect(urls).toEqual(["stun:a"]);
	});

	it("merges turn credentials of both sides", async () => {
		const api = fakeApi({
			getIceServers: vi.fn().mockResolvedValue({
				stun: [],
				turn: [
					{
						urls: ["turn:a"],
						username: "local",
						credential: "local-secret",
					},
				],
			}),
		});
		const manager = createCallManager(api);

		manager.handleIncoming({
			callId: "c-turn",
			chatId: "chat-turn",
			offer: "offer-sdp",
			from: { id: "bob:remote.test", nick: "bob" },
			iceServers: {
				stun: [],
				turn: [
					{
						urls: ["turn:b"],
						username: "remote",
						credential: "remote-secret",
					},
				],
			},
		});

		await manager.accept();

		const servers = FakePeerConnection.instances[0].config?.iceServers ?? [];

		expect(servers).toContainEqual({
			urls: ["turn:a"],
			username: "local",
			credential: "local-secret",
		});
		expect(servers).toContainEqual({
			urls: ["turn:b"],
			username: "remote",
			credential: "remote-secret",
		});
	});

	it("caller stores accepted remote ice without rebuilding the running peer", async () => {
		const api = fakeApi({
			getIceServers: vi.fn().mockResolvedValue({ stun: ["stun:a"], turn: [] }),
			startCall: vi.fn().mockResolvedValue({ callId: "c-1", state: "ringing" }),
		});
		const manager = createCallManager(api);

		await manager.start("chat-1");

		expect(manager.state().phase).toBe("outgoing");
		expect(FakePeerConnection.instances).toHaveLength(1);

		// The callee attached its servers to the answer. The caller peer is
		// already created (the offer was needed for invite), so the union
		// cannot be applied to it: remoteIce is only stored for the next
		// connection (re-offer/restartIce — follow-up).
		manager.handleAccepted({
			callId: "c-1",
			answer: "answer-sdp",
			iceServers: { stun: ["stun:b"], turn: [] },
		});

		await vi.waitFor(() => {
			expect(manager.state().phase).toBe("active");
		});

		const urls = serverUrls(FakePeerConnection.instances[0]);

		expect(urls).toContain("stun:a");
		expect(urls).not.toContain("stun:b");
	});
});
