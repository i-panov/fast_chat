import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallInfo } from "../types/api.ts";
import { useCall } from "./useCall.ts";

const startCall = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ callId: "c-1", state: "ringing" })),
);
const getIceServers = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ stun: [], turn: [] })),
);
const getCurrentCall = vi.hoisted(() =>
	vi.fn<() => Promise<CallInfo>>(() =>
		Promise.reject(new Error("http 404: call not found")),
	),
);
const hangupCall = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ status: "ok" })),
);
const hangupCallOnLeave = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ status: "ok" })),
);

vi.mock("../api.ts", () => ({
	getIceServers,
	startCall,
	acceptCall: vi.fn(() => Promise.resolve({ callId: "c-1", state: "active" })),
	rejectCall: vi.fn(() => Promise.resolve({ status: "ok" })),
	hangupCall,
	hangupCallOnLeave,
	sendCallIce: vi.fn(() => Promise.resolve({ status: "ok" })),
	getCurrentCall,
}));

function stubMedia(stop = vi.fn()) {
	vi.stubGlobal("navigator", {
		mediaDevices: {
			getUserMedia: vi.fn().mockResolvedValue({
				getTracks: () => [{ stop }],
				getAudioTracks: () => [],
				getVideoTracks: () => [],
			}),
		},
	});

	vi.stubGlobal(
		"RTCPeerConnection",
		class {
			createOffer() {
				return Promise.resolve({ type: "offer", sdp: "offer-sdp" });
			}

			setLocalDescription() {
				return Promise.resolve();
			}

			addTrack() {}

			close() {}
		},
	);
}

describe("useCall", () => {
	beforeEach(() => {
		sessionStorage.clear();
	});

	it("follows the state of the call", () => {
		stubMedia();
		const { result } = renderHook(() => useCall("tok", "alice:test"));

		expect(result.current.state.phase).toBe("idle");

		act(() => {
			result.current.manager?.handleIncoming({
				callId: "c-2",
				chatId: "chat-2",
				offer: "offer-sdp",
				from: { id: "bob:test", nick: "bob" },
			});
		});

		expect(result.current.state.phase).toBe("incoming");
		expect(result.current.state.peerNick).toBe("bob");
	});

	it("starts a call in a chat", async () => {
		stubMedia();
		startCall.mockClear();
		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await act(async () => {
			await result.current.start("chat-1");
		});

		expect(startCall).toHaveBeenCalledWith("tok", "chat-1", "offer-sdp");
		expect(result.current.state.phase).toBe("outgoing");
	});

	it("keeps the call when the token is refreshed", async () => {
		stubMedia();
		const { result, rerender } = renderHook(
			({ token }: { token: string }) => useCall(token, "alice:test"),
			{ initialProps: { token: "tok" } },
		);

		await act(async () => {
			await result.current.start("chat-1");
		});

		const manager = result.current.manager;

		rerender({ token: "tok-2" });

		expect(result.current.manager).toBe(manager);
		expect(result.current.state.phase).toBe("outgoing");
	});

	it("ends the call on the server when the page goes away", async () => {
		stubMedia();
		hangupCallOnLeave.mockClear();
		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await act(async () => {
			await result.current.start("chat-1");
		});

		act(() => {
			window.dispatchEvent(new Event("pagehide"));
		});

		expect(hangupCallOnLeave).toHaveBeenCalledWith("tok", "c-1");
	});

	it("releases the media when the page goes away", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const { result, unmount } = renderHook(() => useCall("tok", "alice:test"));

		await act(async () => {
			await result.current.start("chat-1");
		});

		unmount();

		expect(stop).toHaveBeenCalled();
	});

	it("releases the media when the account changes", async () => {
		const stop = vi.fn();
		stubMedia(stop);

		const { result, rerender } = renderHook(
			({ userId }: { userId: string }) => useCall("tok", userId),
			{ initialProps: { userId: "alice:test" } },
		);

		await act(async () => {
			await result.current.start("chat-1");
		});

		rerender({ userId: "bob:test" });

		expect(stop).toHaveBeenCalled();
	});

	it("ends the call of a reloaded page on the server", () => {
		stubMedia();
		hangupCallOnLeave.mockClear();
		sessionStorage.setItem("fastchat.call", "c-7");

		renderHook(() => useCall("tok", "alice:test"));

		expect(hangupCallOnLeave).toHaveBeenCalledWith("tok", "c-7");
		expect(sessionStorage.getItem("fastchat.call")).toBeNull();
	});

	it("keeps the call of another tab", async () => {
		stubMedia();
		getCurrentCall.mockResolvedValueOnce({
			callId: "c-9",
			peer: "bob:test",
			state: "active",
			role: "caller",
		});
		hangupCallOnLeave.mockClear();

		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await waitFor(() => {
			expect(getCurrentCall).toHaveBeenCalled();
		});

		expect(hangupCallOnLeave).not.toHaveBeenCalled();
		expect(result.current.state.phase).toBe("idle");
	});

	it("reports the call that ended while the user was away", async () => {
		stubMedia();
		getCurrentCall.mockResolvedValueOnce({
			callId: "c-9",
			peer: "bob:test",
			state: "ended",
			reason: "timeout",
			role: "callee",
		});

		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await waitFor(() => {
			expect(result.current.state.phase).toBe("ended");
		});

		expect(result.current.state.reason).toBe("timeout");
		expect(result.current.state.role).toBe("callee");
		expect(result.current.state.peerId).toBe("bob:test");
	});

	it("ignores the call the user ended before the page was opened", async () => {
		stubMedia();
		getCurrentCall.mockResolvedValueOnce({
			callId: "c-9",
			peer: "bob:test",
			state: "ended",
			reason: "hangup",
			role: "caller",
		});

		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await waitFor(() => {
			expect(getCurrentCall).toHaveBeenCalled();
		});

		// The reconciliation runs in the background: let it finish.
		await act(async () => {
			await Promise.resolve();
		});

		expect(result.current.state.phase).toBe("idle");
	});

	it("takes the call again that waited for an answer", async () => {
		stubMedia();
		getCurrentCall.mockResolvedValueOnce({
			callId: "c-9",
			peer: "bob:test",
			state: "ringing",
			offer: "offer-sdp",
			role: "callee",
		});

		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await waitFor(() => {
			expect(result.current.state.phase).toBe("incoming");
		});

		expect(result.current.state.callId).toBe("c-9");
	});

	it("reports a refused call", async () => {
		stubMedia();
		startCall.mockRejectedValueOnce(new Error("http 409: busy"));

		const notifications: { message: string; type: string }[] = [];
		const listener = (event: Event) => {
			notifications.push(
				(event as CustomEvent<{ message: string; type: string }>).detail,
			);
		};
		window.addEventListener("app:notification", listener);

		const { result } = renderHook(() => useCall("tok", "alice:test"));

		await act(async () => {
			await result.current.start("chat-1");
		});

		window.removeEventListener("app:notification", listener);

		expect(notifications).toEqual([{ message: "call.failed", type: "error" }]);
		expect(result.current.state.phase).toBe("idle");
	});
});
