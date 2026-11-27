import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n.ts";
import { SessionsModal } from "./SessionsModal.tsx";

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();

	return { ...actual, getSessions: vi.fn(), revokeDeviceSession: vi.fn() };
});

const { ApiError, getSessions, revokeDeviceSession } = await import(
	"../../api.ts"
);

const REVOKE_RE =
	/^(sessions\.revoke|Revoke|End session|Завершить сеанс)(:.*)?$/;
const REVOKE_KEY_RE = /Revoke key/;
const LOGOUT_ALL_RE = /sessions\.logoutAll|Sign out everywhere/;
const CREATED_RE = /^(Created|Создано):/;
const CLEARED_HINT_RE = /does not end server sessions|не завершает сеансы/i;

const current = {
	id: "s1",
	deviceId: "dev-1",
	deviceName: "Chrome on Linux",
	createdAt: "2026-01-01T00:00:00Z",
	lastSeenAt: "2026-01-01T00:00:00Z",
	expiresAt: "2026-01-02T00:00:00Z",
	current: true,
};
const other = {
	...current,
	id: "s2",
	deviceId: "dev-2",
	deviceName: "Phone",
	current: false,
};

const confirmMock = vi.fn(() => true);

beforeEach(() => {
	vi.clearAllMocks();
	confirmMock.mockReturnValue(true);
	Object.defineProperty(window, "confirm", {
		value: confirmMock,
		configurable: true,
	});
});

describe("SessionsModal", () => {
	it("lists devices and revokes another session", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current, other],
		});
		vi.mocked(revokeDeviceSession).mockResolvedValue({ status: "ok" });
		const onLogoutAll = vi.fn();

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={onLogoutAll}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		expect(await screen.findByText("Phone")).toBeTruthy();
		expect(screen.getAllByText(CREATED_RE).length).toBe(2);
		expect(screen.getByText(CLEARED_HINT_RE)).toBeTruthy();

		fireEvent.click(screen.getByRole("button", { name: REVOKE_RE }));

		await waitFor(() => {
			expect(revokeDeviceSession).toHaveBeenCalledWith("tok", "s2");
		});
		await waitFor(() => {
			expect(screen.queryByText("Phone")).toBeNull();
		});
		expect(onLogoutAll).not.toHaveBeenCalled();
	});

	it("does not offer to end the session of the current device", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current],
		});
		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={vi.fn()}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		expect(screen.queryByRole("button", { name: REVOKE_RE })).toBeNull();
		expect(screen.queryByRole("button", { name: REVOKE_KEY_RE })).toBeNull();
	});

	it("treats the id reported by the server as the current session", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [{ ...current, current: false }],
		});

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={vi.fn()}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		expect(screen.queryByRole("button", { name: REVOKE_RE })).toBeNull();
	});

	it("asks the caller to sign out everywhere", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current],
		});
		const onLogoutAll = vi.fn();

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={onLogoutAll}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: LOGOUT_ALL_RE }));
		expect(confirmMock).toHaveBeenCalled();
		expect(onLogoutAll).toHaveBeenCalledTimes(1);
	});

	it("does not sign out everywhere without confirmation", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current],
		});
		confirmMock.mockReturnValue(false);
		const onLogoutAll = vi.fn();

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={onLogoutAll}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: LOGOUT_ALL_RE }));
		expect(onLogoutAll).not.toHaveBeenCalled();
	});

	it("shows a failed sign-out instead of closing silently", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current],
		});
		const onLogoutAll = vi.fn().mockRejectedValue(new Error("network"));
		const onClose = vi.fn();

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={onClose}
					token="tok"
					onLogoutAll={onLogoutAll}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Chrome on Linux")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: LOGOUT_ALL_RE }));

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("drops a session the server reports as already revoked", async () => {
		vi.mocked(getSessions).mockResolvedValue({
			currentSessionId: "s1",
			sessions: [current, other],
		});
		vi.mocked(revokeDeviceSession).mockRejectedValue(
			new ApiError(404, "http 404: not found"),
		);

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={vi.fn()}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("Phone")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: REVOKE_RE }));

		await waitFor(() => {
			expect(screen.queryByText("Phone")).toBeNull();
		});
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows a localized error when the device list fails to load", async () => {
		vi.mocked(getSessions).mockRejectedValue(new Error("http 500"));

		render(
			<MantineProvider>
				<SessionsModal
					open
					onClose={() => {}}
					token="tok"
					onLogoutAll={vi.fn()}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByRole("alert")).toBeTruthy();
	});
});
