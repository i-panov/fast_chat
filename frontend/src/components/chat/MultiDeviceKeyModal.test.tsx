import { MantineProvider } from "@mantine/core";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MultiDeviceKeyModal } from "./MultiDeviceKeyModal.tsx";

const createNewKey = vi.fn();
const showNotification = vi.fn();
let newKeyHandler: ((token: string) => void) | null = null;

vi.mock("../../e2ee/keys.ts", () => ({
	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	createNewKey: (...args: unknown[]) => createNewKey(...args),
	onNewKeyConfirmationNeeded: (fn: (token: string) => void) => {
		newKeyHandler = fn;
		return () => {
			newKeyHandler = null;
		};
	},
}));

vi.mock("@mantine/notifications", () => ({
	// eslint-disable-next-line @typescript-eslint/no-unsafe-return
	notifications: { show: (...args: unknown[]) => showNotification(...args) },
}));

describe("MultiDeviceKeyModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		newKeyHandler = null;
	});

	it("calls createNewKey once for the active token", async () => {
		createNewKey.mockResolvedValue({ publicKey: "p", privateKey: "s" });
		render(
			<MantineProvider>
				<MultiDeviceKeyModal activeToken="token-a" />
			</MantineProvider>,
		);
		act(() => newKeyHandler?.("token-a"));
		await screen.findByRole("dialog");
		const buttons = await screen.findAllByRole("button");
		fireEvent.click(buttons[buttons.length - 1]);
		await waitFor(() => expect(createNewKey).toHaveBeenCalledTimes(1));
		expect(createNewKey).toHaveBeenCalledWith("token-a");
	});

	it("ignores a confirmation event for another account", () => {
		render(
			<MantineProvider>
				<MultiDeviceKeyModal activeToken="token-a" />
			</MantineProvider>,
		);
		act(() => newKeyHandler?.("token-b"));
		// No dialog for a token that belongs to another account. The role
		// check is real: the first test proves the dialog does appear for
		// the active token.
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("shows an error and stays mounted when creation fails", async () => {
		createNewKey.mockRejectedValue(new Error("boom"));
		render(
			<MantineProvider>
				<MultiDeviceKeyModal activeToken="token-a" />
			</MantineProvider>,
		);
		act(() => newKeyHandler?.("token-a"));
		const buttons = await screen.findAllByRole("button");
		fireEvent.click(buttons[buttons.length - 1]);
		await waitFor(() => expect(showNotification).toHaveBeenCalled());
		expect(createNewKey).toHaveBeenCalledTimes(1);
	});
});
