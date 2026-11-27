import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminPage } from "./AdminPage.tsx";

vi.mock("../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../api.ts")>();

	return {
		...actual,
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
	};
});

const account = {
	token: "tok",
	user: { id: "alice:test", nick: "alice", isAdmin: true },
};

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
	useNavigate: () => navigate,
}));

vi.mock("../useAuth.tsx", () => ({
	useAuth: () => ({ activeAccount: account }),
}));

// This suite asserts translation keys: an identity t() keeps it stable
// regardless of the interface language chosen by the test environment.
vi.mock("../i18n.ts", () => ({
	default: { t: (key: string) => key, language: "en" },
	getCurrentLocale: () => "en",
}));

const { adminListUsers, adminPatchUser, adminListChats, adminDeleteChat } =
	await import("../api.ts");

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
	vi.mocked(adminListChats).mockResolvedValue({
		chats: [],
		total: 0,
		offset: 0,
		limit: 50,
	});
	vi.mocked(adminDeleteChat).mockResolvedValue({ status: "ok" });
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
			name: "admin.grantAdmin: bob",
		});
		fireEvent.click(grantButtons[0]);
		fireEvent.click(
			await screen.findByRole("button", { name: "admin.grantAdmin" }),
		);

		await waitFor(() => {
			expect(adminPatchUser).toHaveBeenCalledWith("tok", "bob:test", {
				isAdmin: true,
			});
		});
	});

	it("shows a localized error when a role change is refused", async () => {
		const { ApiError } = await import("../api.ts");
		vi.mocked(adminPatchUser).mockRejectedValue(
			new ApiError(403, "http 403: forbidden"),
		);

		render(
			<MantineProvider>
				<AdminPage />
			</MantineProvider>,
		);

		expect(await screen.findByText("bob@test")).toBeTruthy();
		fireEvent.click(
			(
				await screen.findAllByRole("button", {
					name: "admin.grantAdmin: bob",
				})
			)[0],
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "admin.grantAdmin" }),
		);

		expect(await screen.findByText("admin.forbiddenAction")).toBeTruthy();
	});

	it("deletes a chat only after confirmation", async () => {
		vi.mocked(adminListChats).mockResolvedValue({
			chats: [
				{
					id: "g1:test",
					type: "group",
					name: "Team",
					ownerId: "alice:test",
					createdAt: "2026-01-01T00:00:00Z",
				},
			],
			total: 1,
			offset: 0,
			limit: 50,
		});

		render(
			<MantineProvider>
				<AdminPage />
			</MantineProvider>,
		);

		fireEvent.click(await screen.findByText("admin.chats"));
		expect(await screen.findByText("Team")).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: "admin.delete: Team" }));
		expect(await screen.findByText("admin.deleteChatConfirm")).toBeTruthy();
		expect(adminDeleteChat).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "admin.delete" }));
		await waitFor(() => {
			expect(adminDeleteChat).toHaveBeenCalledWith("tok", "g1:test");
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
