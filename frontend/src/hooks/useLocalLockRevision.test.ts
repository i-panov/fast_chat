import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	KEY_MATERIAL_CHANNEL,
	LOCAL_LOCK_CHANGED_EVENT,
} from "../e2ee/keys.ts";
import { useLocalLockRevision } from "./useLocalLockRevision.ts";

describe("useLocalLockRevision", () => {
	it("bumps on local key-material changes", async () => {
		const { result } = renderHook(() => useLocalLockRevision("acc:test"));
		const before = result.current;
		act(() => {
			window.dispatchEvent(new Event(LOCAL_LOCK_CHANGED_EVENT));
		});
		await waitFor(() => {
			expect(result.current).toBe(before + 1);
		});
	});

	it("bumps when another tab rotates the key for this account", async () => {
		const { result } = renderHook(() => useLocalLockRevision("acc:test"));
		const before = result.current;
		const channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
		channel.postMessage({ scope: "acc:test", tabId: "another-tab" });
		channel.close();
		await waitFor(() => {
			expect(result.current).toBe(before + 1);
		});
	});

	it("ignores key changes of another account", async () => {
		const { result } = renderHook(() => useLocalLockRevision("acc:test"));
		const before = result.current;
		const channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
		channel.postMessage({ scope: "other:test", tabId: "another-tab" });
		channel.close();
		// Give the message a chance to arrive before asserting it was ignored.
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		expect(result.current).toBe(before);
	});
});
