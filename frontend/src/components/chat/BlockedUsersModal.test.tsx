import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n.ts";
import { BlockedUsersModal } from "./BlockedUsersModal.tsx";

vi.mock("../../api.ts", () => ({
	getBlockedUsers: vi.fn(),
	unblockUser: vi.fn(),
}));

const { getBlockedUsers, unblockUser } = await import("../../api.ts");

const UNBLOCK_RE = /blocks\.unblock|Unblock|Разблокировать/;
const EMPTY_RE = /blocks\.empty|not blocked anyone|никого не блокировали/i;

function renderModal() {
	return render(
		<MantineProvider>
			<BlockedUsersModal open onClose={() => {}} token="tok" />
		</MantineProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BlockedUsersModal", () => {
	it("lists blocked users and unblocks one", async () => {
		vi.mocked(getBlockedUsers).mockResolvedValue({
			users: [{ id: "bob:test", nick: "bob" }],
		});
		vi.mocked(unblockUser).mockResolvedValue({ users: [] });

		renderModal();

		expect(await screen.findByText("@bob")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: UNBLOCK_RE }));
		await waitFor(() => {
			expect(unblockUser).toHaveBeenCalledWith("tok", "bob:test");
		});
		await waitFor(() => {
			expect(screen.queryByText("@bob")).toBeNull();
		});
	});

	it("shows an error instead of an empty list when loading fails", async () => {
		vi.mocked(getBlockedUsers).mockRejectedValue(new Error("network"));

		renderModal();

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.queryByText(EMPTY_RE)).toBeNull();
	});

	it("keeps the row and reports a failed unblock", async () => {
		vi.mocked(getBlockedUsers).mockResolvedValue({
			users: [{ id: "bob:test", nick: "bob" }],
		});
		vi.mocked(unblockUser).mockRejectedValue(new Error("http 500"));

		renderModal();

		expect(await screen.findByText("@bob")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: UNBLOCK_RE }));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.getByText("@bob")).toBeTruthy();
	});

	it("shows the id of a blocked federated user without a local profile", async () => {
		vi.mocked(getBlockedUsers).mockResolvedValue({
			users: [{ id: "bob:remote", nick: "" }],
		});

		renderModal();

		expect(await screen.findByText("@bob:remote")).toBeTruthy();
	});
});
