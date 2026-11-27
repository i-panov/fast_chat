import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KEY_TAB_ID } from "./keys.ts";
import { listenForLockRequests, postLockRequest } from "./localLockChannel.ts";

class FakeChannel {
	static instances: FakeChannel[] = [];

	onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
	posted: unknown[] = [];
	closed = false;

	constructor(readonly name: string) {
		FakeChannel.instances.push(this);
	}

	postMessage(data: unknown): void {
		this.posted.push(data);
	}

	close(): void {
		this.closed = true;
	}
}

const NativeBroadcastChannel = globalThis.BroadcastChannel;

beforeEach(() => {
	FakeChannel.instances = [];
	Object.defineProperty(globalThis, "BroadcastChannel", {
		value: FakeChannel,
		configurable: true,
	});
});

afterEach(() => {
	Object.defineProperty(globalThis, "BroadcastChannel", {
		value: NativeBroadcastChannel,
		configurable: true,
	});
});

describe("local lock channel", () => {
	it("posts a lock request for the account and closes the channel", () => {
		postLockRequest("alice:test");

		const [channel] = FakeChannel.instances;
		expect(channel?.name).toBe("fastchat-local-lock");
		expect(channel?.posted).toEqual([
			{ scope: "alice:test", tabId: KEY_TAB_ID },
		]);
		expect(channel?.closed).toBe(true);
	});

	it("locks on a request from another tab", () => {
		const onLock = vi.fn();
		listenForLockRequests(onLock);
		const [channel] = FakeChannel.instances;

		channel?.onmessage?.({
			data: { scope: "alice:test", tabId: "other-tab" },
		} as MessageEvent<unknown>);

		expect(onLock).toHaveBeenCalledWith("alice:test");
	});

	it("ignores its own request and malformed messages", () => {
		const onLock = vi.fn();
		listenForLockRequests(onLock);
		const [channel] = FakeChannel.instances;

		channel?.onmessage?.({
			data: { scope: "alice:test", tabId: KEY_TAB_ID },
		} as MessageEvent<unknown>);
		channel?.onmessage?.({ data: null } as MessageEvent<unknown>);
		channel?.onmessage?.({ data: { scope: 1 } } as MessageEvent<unknown>);

		expect(onLock).not.toHaveBeenCalled();
	});

	it("closes the channel on unsubscribe", () => {
		const off = listenForLockRequests(() => {});
		const [channel] = FakeChannel.instances;

		off();

		expect(channel?.closed).toBe(true);
	});
});
