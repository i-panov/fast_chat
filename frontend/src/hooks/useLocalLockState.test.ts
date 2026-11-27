import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { metaRepo } from "../db/metaRepo.ts";
import {
	KEY_MATERIAL_CHANNEL,
	LOCAL_LOCK_CHANGED_EVENT,
	PASSKEY_LOCK_META,
} from "../e2ee/keys.ts";
import { useLocalLockState } from "./useLocalLockState.ts";

let counter = 0;
let scope: string;

beforeEach(() => {
	scope = `lock-${counter++}:test`;
});

describe("useLocalLockState", () => {
	it("reports a configured lock as locked without keys in memory", async () => {
		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, "{}");

		const { result } = renderHook(() => useLocalLockState(scope));

		await waitFor(() => {
			expect(result.current.enabled).toBe(true);
		});
		expect(result.current.locked).toBe(true);
	});

	it("follows lock changes", async () => {
		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, "{}");
		const { result } = renderHook(() => useLocalLockState(scope));
		await waitFor(() => {
			expect(result.current.enabled).toBe(true);
		});

		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
		act(() => {
			window.dispatchEvent(new Event(LOCAL_LOCK_CHANGED_EVENT));
		});

		await waitFor(() => {
			expect(result.current.enabled).toBe(false);
		});
	});

	it("re-reads the state when another tab changes the lock", async () => {
		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, "{}");
		const { result } = renderHook(() => useLocalLockState(scope));
		await waitFor(() => {
			expect(result.current.enabled).toBe(true);
		});

		await metaRepo.setNoNotifyFor(scope, PASSKEY_LOCK_META, null);
		const channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
		channel.postMessage({ scope, tabId: "another-tab" });
		channel.close();

		await waitFor(() => {
			expect(result.current.enabled).toBe(false);
		});
	});
});
