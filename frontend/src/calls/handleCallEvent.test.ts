import { describe, expect, it, vi } from "vitest";
import { handleCallEvent } from "./handleCallEvent.ts";

function fakeManager() {
	return {
		handleIncoming: vi.fn(),
		handleAccepted: vi.fn(),
		handleEnded: vi.fn(),
		handleIce: vi.fn(),
	};
}

describe("handleCallEvent", () => {
	it("routes an incoming call to the manager", () => {
		const manager = fakeManager();
		const payload = {
			callId: "c-1",
			chatId: "chat-1",
			offer: "offer-sdp",
			from: { id: "bob:test", nick: "bob" },
		};

		handleCallEvent(manager as never, "call_incoming", payload);

		expect(manager.handleIncoming).toHaveBeenCalledWith(payload);
	});

	it("routes the accepted call", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_accepted", {
			callId: "c-1",
			answer: "answer-sdp",
		});

		expect(manager.handleAccepted).toHaveBeenCalledWith({
			callId: "c-1",
			answer: "answer-sdp",
		});
	});

	it("routes the ending of a call", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_ended", {
			callId: "c-1",
			reason: "hangup",
		});

		expect(manager.handleEnded).toHaveBeenCalledWith({
			callId: "c-1",
			reason: "hangup",
		});
	});

	it("routes an ICE candidate", () => {
		const manager = fakeManager();
		const payload = { callId: "c-1", candidate: { candidate: "c" } };

		handleCallEvent(manager as never, "call_ice", payload);

		expect(manager.handleIce).toHaveBeenCalledWith(payload);
	});

	it("ignores an unknown event", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "something_else", {});

		expect(manager.handleIncoming).not.toHaveBeenCalled();
		expect(manager.handleEnded).not.toHaveBeenCalled();
	});

	it("ignores a broken incoming payload", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_incoming", { callId: "c-1" });
		handleCallEvent(manager as never, "call_incoming", null);

		expect(manager.handleIncoming).not.toHaveBeenCalled();
	});

	it("ignores a broken ending without an identifier", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_ended", { reason: "hangup" });

		expect(manager.handleEnded).not.toHaveBeenCalled();
	});

	it("ignores a broken ICE payload", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_ice", { candidate: "c" });

		expect(manager.handleIce).not.toHaveBeenCalled();
	});
});
