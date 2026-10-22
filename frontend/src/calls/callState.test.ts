import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createCallManager } from "./callManager.ts";
import { createCallStore, useCallState } from "./callState.ts";
import type { CallApi } from "./callTypes.ts";

function fakeApi(): CallApi {
	return {
		token: "tok",
		getIceServers: vi.fn().mockResolvedValue({ stun: [], turn: [] }),
		startCall: vi.fn().mockResolvedValue({ callId: "c-1", state: "ringing" }),
		acceptCall: vi.fn().mockResolvedValue({ callId: "c-1", state: "active" }),
		rejectCall: vi.fn().mockResolvedValue({ status: "ok" }),
		hangupCall: vi.fn().mockResolvedValue({ status: "ok" }),
		sendCallIce: vi.fn().mockResolvedValue({ status: "ok" }),
	};
}

describe("createCallStore", () => {
	it("follows the state of the manager", () => {
		const manager = createCallManager(fakeApi());
		const store = createCallStore(manager);
		const listener = vi.fn();

		store.subscribe(listener);

		expect(store.getSnapshot().phase).toBe("idle");

		manager.handleIncoming({
			callId: "c-2",
			chatId: "chat-2",
			offer: "offer-sdp",
			from: { id: "bob:test", nick: "bob" },
		});

		expect(listener).toHaveBeenCalled();
		expect(store.getSnapshot().phase).toBe("incoming");
		expect(store.getSnapshot().peerNick).toBe("bob");

		store.dispose();
	});

	it("stops following the manager after it is disposed", () => {
		const manager = createCallManager(fakeApi());
		const store = createCallStore(manager);
		const listener = vi.fn();

		store.subscribe(listener);

		// The manager has a call: only then does an ending reach the
		// subscribers.
		manager.handleIncoming({
			callId: "c-2",
			chatId: "chat-2",
			offer: "offer-sdp",
			from: { id: "bob:test", nick: "bob" },
		});

		expect(listener).toHaveBeenCalled();

		store.dispose();
		listener.mockClear();

		manager.handleEnded({ callId: "c-2", reason: "timeout" });

		expect(listener).not.toHaveBeenCalled();
	});

	it("gives the component the state of the call", () => {
		const manager = createCallManager(fakeApi());
		const store = createCallStore(manager);
		const { result } = renderHook(() => useCallState(store));

		expect(result.current.phase).toBe("idle");

		act(() => {
			manager.handleIncoming({
				callId: "c-2",
				chatId: "chat-2",
				offer: "offer-sdp",
				from: { id: "bob:test", nick: "bob" },
			});
		});

		expect(result.current.phase).toBe("incoming");
		expect(result.current.peerNick).toBe("bob");

		store.dispose();
	});
});
