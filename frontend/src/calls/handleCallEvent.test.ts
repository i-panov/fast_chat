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

		handleCallEvent(manager as never, "call_incoming", { callId: "c-1" });

		expect(manager.handleIncoming).toHaveBeenCalledWith({ callId: "c-1" });
	});

	it("routes the accepted call", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_accepted", { callId: "c-1" });

		expect(manager.handleAccepted).toHaveBeenCalledWith({ callId: "c-1" });
	});

	it("routes the ending of a call", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_ended", { reason: "hangup" });

		expect(manager.handleEnded).toHaveBeenCalledWith({ reason: "hangup" });
	});

	it("routes an ICE candidate", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "call_ice", { candidate: "c" });

		expect(manager.handleIce).toHaveBeenCalledWith({ candidate: "c" });
	});

	it("ignores an unknown event", () => {
		const manager = fakeManager();

		handleCallEvent(manager as never, "something_else", {});

		expect(manager.handleIncoming).not.toHaveBeenCalled();
		expect(manager.handleEnded).not.toHaveBeenCalled();
	});
});
