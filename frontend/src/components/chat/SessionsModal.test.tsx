import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionsModal } from "./SessionsModal.tsx";

vi.mock("../../api.ts", () => ({
	getSessions: vi.fn(),
	revokeDeviceSession: vi.fn(),
}));

const { getSessions, revokeDeviceSession } = await import("../../api.ts");

const REVOKE_RE = /sessions\.revoke|Revoke/;
const LOGOUT_ALL_RE = /sessions\.logoutAll|Sign out everywhere/;

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

beforeEach(() => {
	vi.clearAllMocks();
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

		fireEvent.click(screen.getByRole("button", { name: REVOKE_RE }));

		await waitFor(() => {
			expect(revokeDeviceSession).toHaveBeenCalledWith("tok", "s2");
		});
		await waitFor(() => {
			expect(screen.queryByText("Phone")).toBeNull();
		});
		expect(onLogoutAll).not.toHaveBeenCalled();
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
		expect(onLogoutAll).toHaveBeenCalledTimes(1);
	});
});
