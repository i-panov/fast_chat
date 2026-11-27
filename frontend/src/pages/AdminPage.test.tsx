import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage.tsx";

vi.mock("../api.ts", () => ({
	adminListUsers: vi.fn(),
	adminPatchUser: vi.fn(),
	adminListChats: vi.fn(),
	adminDeleteChat: vi.fn(),
	adminListMessages: vi.fn(),
	adminDeleteMessage: vi.fn(),
	adminListBots: vi.fn(),
	adminPatchBot: vi.fn(),
	adminListFederationPeers: vi.fn(),
	adminListAudit: vi.fn(),
}));

const account = {
	token: "tok",
	user: { id: "alice:test", nick: "alice", isAdmin: true },
};

vi.mock("../useAuth.tsx", () => ({
	useAuth: () => ({ activeAccount: account }),
}));

// This suite asserts translation keys: an identity t() keeps it stable
// regardless of the interface language chosen by the test environment.
vi.mock("../i18n.ts", () => ({
	default: { t: (key: string) => key, language: "en" },
	getCurrentLocale: () => "en",
}));

const { adminListUsers, adminPatchUser } = await import("../api.ts");

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(adminListUsers).mockResolvedValue({
		users: [
			{
				id: "alice:test",
				username: "alice",
				email: "alice@test",
				isBot: false,
				isAdmin: true,
				banned: false,
				online: true,
			},
			{
				id: "bob:test",
				username: "bob",
				email: "bob@test",
				isBot: false,
				isAdmin: false,
				banned: false,
				online: false,
			},
		],
		total: 2,
		offset: 0,
		limit: 50,
	});
	vi.mocked(adminPatchUser).mockResolvedValue({ status: "ok" });
});

describe("AdminPage", () => {
	it("lists accounts and grants the role", async () => {
		render(
			<MantineProvider>
				<AdminPage />
			</MantineProvider>,
		);

		expect(await screen.findByText("bob@test")).toBeTruthy();

		const grantButtons = await screen.findAllByRole("button", {
			name: "admin.grantAdmin",
		});
		fireEvent.click(grantButtons[0]);
		fireEvent.click(
			await screen.findByRole("button", { name: "admin.confirm" }),
		);

		await waitFor(() => {
			expect(adminPatchUser).toHaveBeenCalledWith("tok", "bob:test", {
				isAdmin: true,
			});
		});
	});

	it("does not offer the admin panel to a regular account", async () => {
		const auth = await import("../useAuth.tsx");
		vi.spyOn(auth, "useAuth").mockReturnValue({
			activeAccount: {
				token: "tok",
				user: { id: "bob:test", nick: "bob" },
			},
		} as never);

		render(
			<MantineProvider>
				<AdminPage />
			</MantineProvider>,
		);

		expect(screen.getByText("admin.forbidden")).toBeTruthy();
		expect(adminListUsers).not.toHaveBeenCalled();
	});
});
