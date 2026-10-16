import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import type { Chat } from "../types/api.ts";

vi.mock("../api.ts", () => ({
	createChat: vi.fn(),
	getChatInfo: vi.fn(),
	updateChat: vi.fn(),
	addChatMember: vi.fn(),
	removeChatMember: vi.fn(),
	deleteChat: vi.fn(),
	uploadFile: vi.fn(),
	uploadChatAvatar: vi.fn(),
}));

vi.mock("../sync/syncEngine.ts", () => ({
	scheduleSync: vi.fn(),
}));

const api = await import("../api.ts");
const { scheduleSync } = await import("../sync/syncEngine.ts");
const { useGroupSettings } = await import("./useGroupSettings.ts");

function chat(id: string, name: string): Chat {
	return {
		id,
		type: "group",
		name,
		ownerId: "alice:test",
		members: [{ id: "alice:test", nick: "alice" }],
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function params(overrides: Record<string, unknown> = {}) {
	return {
		token: "tok",
		userId: "alice:test",
		activeChatId: "c1",
		selectChat: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
});

describe("useGroupSettings", () => {
	it("creates a group and selects it", async () => {
		vi.mocked(api.createChat).mockResolvedValueOnce({
			chat: chat("g1", "Team"),
		});
		const p = params();
		const { result } = renderHook(() => useGroupSettings(p));

		await act(async () => {
			await result.current.handleCreateGroup("Team", ["bob:test"]);
		});

		expect(api.createChat).toHaveBeenCalledWith("tok", {
			type: "group",
			name: "Team",
			memberIds: ["bob:test"],
		});
		expect(await chatsRepo.getById("g1")).toBeTruthy();
		expect(result.current.createGroupOpen).toBe(false);
		expect(p.selectChat).toHaveBeenCalledWith("g1");
	});

	it("does nothing without a token", async () => {
		const { result } = renderHook(() =>
			useGroupSettings(params({ token: undefined })),
		);

		await act(async () => {
			await result.current.handleCreateGroup("x", []);
		});
		await act(async () => {
			await result.current.openGroupSettings("c1");
		});
		await act(async () => {
			await result.current.handleRenameGroup("y");
		});
		await act(async () => {
			await result.current.handleAddGroupMember("b");
		});
		await act(async () => {
			await result.current.handleRemoveGroupMember("b");
		});
		await act(async () => {
			await result.current.handleDeleteGroup();
		});
		await act(async () => {
			await result.current.handleUploadGroupAvatar(new File(["x"], "a.png"));
		});

		expect(api.createChat).not.toHaveBeenCalled();
		expect(api.getChatInfo).not.toHaveBeenCalled();
	});

	it("opens settings and renames the group", async () => {
		vi.mocked(api.getChatInfo).mockResolvedValueOnce({
			chat: chat("c1", "Old"),
		});
		vi.mocked(api.updateChat).mockResolvedValueOnce({
			chat: chat("c1", "New"),
		});
		const { result } = renderHook(() => useGroupSettings(params()));

		await act(async () => {
			await result.current.openGroupSettings("c1");
		});

		await waitFor(() => {
			expect(result.current.groupSettings?.name).toBe("Old");
		});
		expect(result.current.groupSettingsChatId).toBe("c1");

		await act(async () => {
			await result.current.handleRenameGroup("New");
		});

		await waitFor(() => {
			expect(result.current.groupSettings?.name).toBe("New");
		});
		expect((await chatsRepo.getById("c1"))?.name).toBe("New");

		act(() => {
			result.current.closeGroupSettings();
		});
		expect(result.current.groupSettingsChatId).toBeNull();
		expect(result.current.groupSettings).toBeNull();
	});

	it("resets when opening fails", async () => {
		vi.mocked(api.getChatInfo).mockRejectedValueOnce(new Error("404"));
		const { result } = renderHook(() => useGroupSettings(params()));

		await act(async () => {
			await result.current.openGroupSettings("missing");
		});

		expect(result.current.groupSettingsChatId).toBeNull();
	});

	it("adds and removes members", async () => {
		const withBob = chat("c1", "G");
		withBob.members.push({ id: "bob:test", nick: "bob" });
		vi.mocked(api.getChatInfo).mockResolvedValueOnce({ chat: chat("c1", "G") });
		vi.mocked(api.addChatMember).mockResolvedValueOnce({ chat: withBob });
		vi.mocked(api.removeChatMember).mockResolvedValueOnce({
			chat: chat("c1", "G"),
		});
		const p = params();
		const { result } = renderHook(() => useGroupSettings(p));

		await act(async () => {
			await result.current.openGroupSettings("c1");
		});
		await act(async () => {
			await result.current.handleAddGroupMember("bob:test");
		});

		await waitFor(() => {
			expect(result.current.groupSettings?.members).toHaveLength(2);
		});

		await act(async () => {
			await result.current.handleRemoveGroupMember("bob:test");
		});

		await waitFor(() => {
			expect(result.current.groupSettings?.members).toHaveLength(1);
		});
		// Someone else left: settings stay open, selection kept.
		expect(result.current.groupSettingsChatId).toBe("c1");
		expect(p.selectChat).not.toHaveBeenCalled();
	});

	it("self-removal closes settings and deselects the chat", async () => {
		vi.mocked(api.getChatInfo).mockResolvedValueOnce({ chat: chat("c1", "G") });
		vi.mocked(api.removeChatMember).mockResolvedValueOnce({
			chat: chat("c1", "G"),
		});
		const p = params();
		const { result } = renderHook(() => useGroupSettings(p));

		await act(async () => {
			await result.current.openGroupSettings("c1");
		});
		await act(async () => {
			await result.current.handleRemoveGroupMember("alice:test");
		});

		expect(result.current.groupSettingsChatId).toBeNull();
		expect(p.selectChat).toHaveBeenCalledWith(null);
	});

	it("deletes the group and syncs", async () => {
		vi.mocked(api.getChatInfo).mockResolvedValueOnce({ chat: chat("c1", "G") });
		vi.mocked(api.deleteChat).mockResolvedValueOnce({ status: "ok" });
		const p = params();
		const { result } = renderHook(() => useGroupSettings(p));

		await act(async () => {
			await result.current.openGroupSettings("c1");
		});
		await act(async () => {
			await result.current.handleDeleteGroup();
		});

		expect(api.deleteChat).toHaveBeenCalledWith("tok", "c1");
		expect(vi.mocked(scheduleSync)).toHaveBeenCalledTimes(1);
		expect(result.current.groupSettingsChatId).toBeNull();
		expect(p.selectChat).toHaveBeenCalledWith(null);
	});

	it("uploads a group avatar", async () => {
		const updated = chat("c1", "G");
		vi.mocked(api.getChatInfo).mockResolvedValueOnce({ chat: chat("c1", "G") });
		vi.mocked(api.uploadFile).mockResolvedValueOnce({
			file: {
				id: "av1",
				mimeType: "image/png",
				size: 10,
				originalName: "a.png",
				fileType: "photo",
				url: "https://srv/av1",
			},
		});
		vi.mocked(api.uploadChatAvatar).mockResolvedValueOnce({ chat: updated });
		const { result } = renderHook(() => useGroupSettings(params()));

		await act(async () => {
			await result.current.openGroupSettings("c1");
		});
		await act(async () => {
			await result.current.handleUploadGroupAvatar(new File(["x"], "a.png"));
		});

		expect(api.uploadFile).toHaveBeenCalledTimes(1);
		expect(api.uploadChatAvatar).toHaveBeenCalledWith("tok", "c1", "av1");
		expect((await chatsRepo.getById("c1"))?.name).toBe("G");
	});
});
