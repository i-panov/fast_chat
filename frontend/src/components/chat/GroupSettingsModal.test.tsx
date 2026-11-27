import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat } from "../../types/api.ts";
import { AuthProvider } from "../../useAuth.tsx";
import { GroupSettingsModal } from "./GroupSettingsModal.tsx";

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();

	return { ...actual, searchUsers: vi.fn() };
});

const { searchUsers } = await import("../../api.ts");

const RENAME_BUTTON = /Rename|chat\.rename/;
const SAVE_BUTTON = /^Save$|^chat\.save$/;
const LEAVE_BUTTON = /Leave group|chat\.leaveGroup/;
const DELETE_BUTTON = /Delete group|chat\.deleteGroup/;
const DELETE_CONFIRM_NAME_RE = /Delete the group "Team"|Удалить группу «Team»/;

function seedAccount() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "tok",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "tok");
}

function chat(overrides: Partial<Chat> = {}): Chat {
	return {
		id: "g1",
		type: "group",
		name: "Team",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice", online: true },
			{ id: "bob:test", nick: "bob" },
		],
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

function callbacks(
	overrides: Record<string, (...args: never[]) => unknown> = {},
) {
	return {
		onClose: vi.fn(),
		onRename: vi.fn(),
		onAddMember: vi.fn(),
		onRemoveMember: vi.fn(),
		onDelete: vi.fn(),
		onUploadAvatar: vi.fn(),
		...overrides,
	};
}

function renderModal(c: Chat | null, cb: ReturnType<typeof callbacks>) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<GroupSettingsModal
					open={true}
					chat={c}
					onClose={cb.onClose}
					onRename={cb.onRename}
					onAddMember={cb.onAddMember}
					onRemoveMember={cb.onRemoveMember}
					onDelete={cb.onDelete}
					onUploadAvatar={cb.onUploadAvatar}
				/>
			</AuthProvider>
		</MantineProvider>,
	);
}

function nameDraftInput(): HTMLInputElement {
	const inputs = [...document.querySelectorAll("input")].filter(
		(el): el is HTMLInputElement =>
			el instanceof HTMLInputElement && el.type !== "file",
	);
	// The search field is empty; the rename draft is the only filled input.
	const draft = inputs.find((i) => i.value !== "");
	if (!draft) throw new Error("no draft input");

	return draft;
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	vi.clearAllMocks();
	vi.spyOn(window, "confirm").mockReturnValue(true);
	vi.mocked(searchUsers).mockResolvedValue({ users: [] });
});

describe("group settings modal", () => {
	it("renders nothing without a chat", () => {
		const cb = callbacks();
		const { container } = renderModal(null, cb);

		expect(container.querySelector("section")).toBeNull();
	});

	it("renames the group", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(RENAME_BUTTON));
		fireEvent.change(nameDraftInput(), { target: { value: "Renamed" } });
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		await waitFor(() => {
			expect(cb.onRename).toHaveBeenCalledWith("Renamed");
		});
	});

	it("cancels an empty rename", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(RENAME_BUTTON));
		fireEvent.change(nameDraftInput(), { target: { value: "   " } });
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		await waitFor(() => {
			expect(cb.onRename).not.toHaveBeenCalled();
		});
	});

	it("adds a member from search", async () => {
		vi.mocked(searchUsers).mockResolvedValue({
			users: [{ id: "carol:test", nick: "carol", online: false }],
		});
		const cb = callbacks();
		renderModal(chat(), cb);

		const search = [...document.querySelectorAll("input")].find(
			(el) => el.getAttribute("placeholder") !== null,
		);
		if (!(search instanceof HTMLInputElement)) throw new Error("no search");
		fireEvent.change(search, { target: { value: "car" } });

		await screen.findByText("@carol");
		fireEvent.click(screen.getByText("@carol"));

		expect(cb.onAddMember).toHaveBeenCalledWith("carol:test");
	});

	it("removes a member from the list", () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		// Alice is the owner: only Bob's row has a remove button.
		const remove = document.querySelector("button.mantine-ActionIcon-root");
		if (!(remove instanceof HTMLButtonElement)) throw new Error("no remove");
		fireEvent.click(remove);

		expect(cb.onRemoveMember).toHaveBeenCalledWith("bob:test");
	});

	it("leaves the group with confirmation", async () => {
		const nonOwner = chat({
			ownerId: "bob:test",
			members: [
				{ id: "bob:test", nick: "bob" },
				{ id: "alice:test", nick: "alice" },
			],
		});
		const cb = callbacks();
		renderModal(nonOwner, cb);

		fireEvent.click(screen.getByText(LEAVE_BUTTON));
		fireEvent.click(screen.getByText(LEAVE_BUTTON));

		await waitFor(() => {
			expect(cb.onRemoveMember).toHaveBeenCalledWith("alice:test");
		});
	});

	it("deletes the group with confirmation", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(DELETE_BUTTON));
		// The confirmation names the group and labels the action, not "Save".
		expect(screen.getByText(DELETE_CONFIRM_NAME_RE)).toBeTruthy();
		fireEvent.click(screen.getByText(DELETE_BUTTON));

		await waitFor(() => {
			expect(cb.onDelete).toHaveBeenCalledTimes(1);
		});
	});

	it("uploads an avatar", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		const picker = [...document.querySelectorAll("input")].find(
			(el) => el.type === "file",
		);
		if (!(picker instanceof HTMLInputElement)) throw new Error("no picker");
		fireEvent.change(picker, {
			target: { files: [new File(["x"], "a.png", { type: "image/png" })] },
		});

		await waitFor(() => {
			expect(cb.onUploadAvatar).toHaveBeenCalledTimes(1);
		});
		const file = vi.mocked(cb.onUploadAvatar).mock.calls[0][0] as File;
		expect(file.name).toBe("a.png");
	});

	it("accepts a long Cyrillic name that fits the rune limit", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		const name = "г".repeat(40); // 80 UTF-8 bytes, 40 runes
		fireEvent.click(screen.getByText(RENAME_BUTTON));
		fireEvent.change(nameDraftInput(), { target: { value: name } });
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		await waitFor(() => {
			expect(cb.onRename).toHaveBeenCalledWith(name);
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("rejects a name longer than 60 runes before sending it", async () => {
		const cb = callbacks();
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(RENAME_BUTTON));
		fireEvent.change(nameDraftInput(), {
			target: { value: "г".repeat(61) },
		});
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(cb.onRename).not.toHaveBeenCalled();
	});

	it("shows a rejected rename and keeps editing", async () => {
		const cb = callbacks({
			onRename: vi.fn().mockRejectedValue(new Error("http 403")),
		});
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(RENAME_BUTTON));
		fireEvent.change(nameDraftInput(), { target: { value: "Nope" } });
		fireEvent.click(screen.getByText(SAVE_BUTTON));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(nameDraftInput().value).toBe("Nope");
	});

	it("keeps the delete confirmation open when the server refuses", async () => {
		const cb = callbacks({
			onDelete: vi.fn().mockRejectedValue(new Error("http 500")),
		});
		renderModal(chat(), cb);

		fireEvent.click(screen.getByText(DELETE_BUTTON));
		fireEvent.click(screen.getByText(DELETE_BUTTON));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText(DELETE_BUTTON)).toBeTruthy();
	});

	it("does not offer bots as group members", async () => {
		vi.mocked(searchUsers).mockResolvedValue({
			users: [
				{ id: "carol:test", nick: "carol", online: false },
				{
					id: "helper_bot:test",
					nick: "helper_bot",
					online: true,
					isBot: true,
				},
			],
		});
		const cb = callbacks();
		renderModal(chat(), cb);

		const search = [...document.querySelectorAll("input")].find(
			(el) => el.getAttribute("placeholder") !== null,
		);
		if (!(search instanceof HTMLInputElement)) throw new Error("no search");
		fireEvent.change(search, { target: { value: "he" } });

		await screen.findByText("@carol");
		expect(screen.queryByText("@helper_bot")).toBeNull();
	});
});
