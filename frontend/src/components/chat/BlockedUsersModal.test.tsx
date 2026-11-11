import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BlockedUsersModal } from "./BlockedUsersModal.tsx";

vi.mock("../../api.ts", () => ({
	getBlockedUsers: vi.fn(),
	unblockUser: vi.fn(),
}));

const { getBlockedUsers, unblockUser } = await import("../../api.ts");

const UNBLOCK_RE = /blocks\.unblock|Unblock/;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("BlockedUsersModal", () => {
	it("lists blocked users and unblocks one", async () => {
		vi.mocked(getBlockedUsers).mockResolvedValue({
			users: [{ id: "bob:test", nick: "bob" }],
		});
		vi.mocked(unblockUser).mockResolvedValue({ users: [] });

		render(
			<MantineProvider>
				<BlockedUsersModal open onClose={() => {}} token="tok" />
			</MantineProvider>,
		);

		expect(await screen.findByText("@bob")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: UNBLOCK_RE }));
		await waitFor(() => {
			expect(unblockUser).toHaveBeenCalledWith("tok", "bob:test");
		});
		await waitFor(() => {
			expect(screen.queryByText("@bob")).toBeNull();
		});
	});
});
