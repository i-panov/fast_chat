import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSwitcher } from "./AccountSwitcher.tsx";
import { AuthProvider } from "./useAuth.tsx";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		useNavigate: () => navigate,
	};
});

vi.mock("./api.ts", () => ({
	getConfig: vi.fn(),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
	uploadPublicKey: vi.fn(),
}));

const { getConfig } = await import("./api.ts");

function seedAccounts() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "t1",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
			{
				token: "t2",
				user: { id: "bob:test", nick: "bob" },
				email: "b@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "t1");
}

function renderSwitcher(
	props: { onLogout?: () => void; onClose?: () => void } = {},
) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<AccountSwitcher
					open={true}
					onClose={props.onClose ?? (() => {})}
					onLogout={props.onLogout ?? (() => {})}
				/>
			</AuthProvider>
		</MantineProvider>,
	);
}

const LOGOUT_BUTTON = /Logout|accounts\.logout/;
const CANCEL_BUTTON = /^Cancel$|accounts\.cancel/;
const CLEAR_DATA_BUTTON = /Clear cache|accounts\.clearData/;
const BACKUP_BUTTON = /Key backup|backup\.open/;
const ADD_ACCOUNT_BUTTON = /Add Account|accounts\.add/;

function buttonByText(pattern: RegExp): HTMLButtonElement {
	const btn = [...document.querySelectorAll("button")].find((b) =>
		pattern.test(b.textContent ?? ""),
	);
	if (!(btn instanceof HTMLButtonElement)) {
		throw new Error(`no button matching ${pattern}`);
	}

	return btn;
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccounts();
	vi.clearAllMocks();
	vi.mocked(getConfig).mockResolvedValue({
		messageEditTTL: 60,
		messageDeleteTTL: 120,
	});
});

describe("account switcher", () => {
	it("lists accounts and switches on click", async () => {
		const onClose = vi.fn();
		renderSwitcher({ onClose });

		expect(screen.getByText("@alice")).toBeTruthy();
		expect(screen.getByText("@bob")).toBeTruthy();

		fireEvent.click(screen.getByText("@bob"));

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		expect(sessionStorage.getItem("activeToken")).toBe("t2");
	});

	it("clicking the active account does nothing", () => {
		const onClose = vi.fn();
		renderSwitcher({ onClose });

		fireEvent.click(screen.getByText("@alice"));

		expect(onClose).not.toHaveBeenCalled();
	});

	it("confirms logout", async () => {
		const onLogout = vi.fn();
		const onClose = vi.fn();
		renderSwitcher({ onLogout, onClose });

		fireEvent.click(buttonByText(LOGOUT_BUTTON));
		// Cancel first: nothing happens.
		await screen.findByText(CANCEL_BUTTON);
		fireEvent.click(buttonByText(CANCEL_BUTTON));
		expect(onLogout).not.toHaveBeenCalled();

		fireEvent.click(buttonByText(LOGOUT_BUTTON));
		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[buttons.length - 1]);

		expect(onLogout).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("clears all data with confirmation", async () => {
		const onClose = vi.fn();
		localStorage.setItem("other", "x");
		renderSwitcher({ onClose });

		fireEvent.click(buttonByText(CLEAR_DATA_BUTTON));
		await screen.findByText(CANCEL_BUTTON);
		const buttons = [...document.querySelectorAll("button")];
		fireEvent.click(buttons[buttons.length - 1]);

		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		expect(localStorage.getItem("other")).toBeNull();
	});

	it("opens the backup settings", async () => {
		renderSwitcher({});

		fireEvent.click(buttonByText(BACKUP_BUTTON));

		await waitFor(() => {
			expect(
				[...document.querySelectorAll("input")].some(
					(i) => i.type === "password",
				),
			).toBe(true);
		});
	});

	it("navigates to login for a new account", () => {
		const onClose = vi.fn();
		renderSwitcher({ onClose });

		fireEvent.click(buttonByText(ADD_ACCOUNT_BUTTON));

		expect(onClose).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith({ to: "/login" });
	});

	it("shows the server version", async () => {
		vi.mocked(getConfig).mockResolvedValue({
			messageEditTTL: 60,
			messageDeleteTTL: 120,
			version: "1.2.3",
			commit: "abc",
		});
		renderSwitcher({});

		await screen.findByText("v-1.2.3-abc");
	});
});
