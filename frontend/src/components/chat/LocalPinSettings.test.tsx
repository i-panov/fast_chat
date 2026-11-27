import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackupState } from "../../e2ee/keys.ts";
import { LocalPinSettings } from "./LocalPinSettings.tsx";

/* eslint-disable @typescript-eslint/no-unsafe-return -- vi.fn() doubles are untyped in these tests. */

const PIN_PATTERN = /^\d{6}$/;

const mocks = vi.hoisted(() => {
	class LocalLockRequiredError extends Error {}
	class WeakLocalPinError extends Error {}
	class LocalLockThrottledError extends Error {
		readonly retryAfterSeconds = 30;
	}
	class PasskeyPrfUnsupportedError extends Error {}
	class PasskeyPrfMissingError extends Error {}
	class PasskeyPrfUnstableError extends Error {}
	const settings = {
		inactivityMs: null,
		backgroundMs: null,
		lockOnFreeze: false,
		lockAfterSleep: false,
	};
	return {
		LocalLockRequiredError,
		WeakLocalPinError,
		LocalLockThrottledError,
		PasskeyPrfUnsupportedError,
		PasskeyPrfMissingError,
		PasskeyPrfUnstableError,
		settings,
		getServerBackupState: vi.fn(),
		hasPinLock: vi.fn(),
		hasPasskeyLock: vi.fn(),
		hasServerPasskeyBackup: vi.fn(),
		enableLocalPin: vi.fn(),
		enablePasskey: vi.fn(),
	};
});

vi.mock("../../e2ee/keys.ts", () => ({
	getServerBackupState: (...args: unknown[]) =>
		mocks.getServerBackupState(...args),
	hasPinLock: () => mocks.hasPinLock(),
	hasWebLocks: () => true,
	LocalLockRequiredError: mocks.LocalLockRequiredError,
	notifyServerBackupChanged: vi.fn(),
	onServerBackupChanged: () => () => {},
}));

vi.mock("../../e2ee/localLock.ts", () => ({
	disableLocalPin: vi.fn(),
	enableLocalPin: (...args: unknown[]) => mocks.enableLocalPin(...args),
	isWeakLocalPin: (pin: string) =>
		["000000", "111111", "123456", "654321"].includes(pin),
	get LOCAL_PIN_PATTERN(): RegExp {
		return PIN_PATTERN;
	},
	LocalLockThrottledError: mocks.LocalLockThrottledError,
	onLocalLockChanged: () => () => {},
	WeakLocalPinError: mocks.WeakLocalPinError,
}));

vi.mock("../../e2ee/localLockSettings.ts", () => ({
	DEFAULT_LOCK_SETTINGS: mocks.settings,
	getLocalLockSettings: () => Promise.resolve(mocks.settings),
	setLocalLockSettings: vi.fn(),
}));

vi.mock("../../e2ee/passkeyLock.ts", () => ({
	disablePasskey: vi.fn(),
	disableServerPasskey: vi.fn(),
	enablePasskey: (...args: unknown[]) => mocks.enablePasskey(...args),
	enableServerPasskey: vi.fn(),
	hasPasskeyLock: () => mocks.hasPasskeyLock(),
	hasServerPasskeyBackup: () => mocks.hasServerPasskeyBackup(),
	isPasskeyUnlockAvailable: () => true,
	PasskeyPrfMissingError: mocks.PasskeyPrfMissingError,
	PasskeyPrfUnstableError: mocks.PasskeyPrfUnstableError,
	PasskeyPrfUnsupportedError: mocks.PasskeyPrfUnsupportedError,
}));

function renderPanel() {
	return render(
		<MantineProvider>
			<LocalPinSettings token="tok" />
		</MantineProvider>,
	);
}

function pinInputs(): HTMLInputElement[] {
	return [...document.querySelectorAll("input")].filter(
		(input): input is HTMLInputElement => input instanceof HTMLInputElement,
	);
}

const ENABLE_BUTTON = /localLock\.enable/;
const PASSKEY_ENABLE_BUTTON = /localLock\.passkeyEnable/;

function enableButton(): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((item) =>
		ENABLE_BUTTON.test(item.textContent ?? ""),
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error("no enable");
	return button;
}

describe("LocalPinSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.hasPinLock.mockResolvedValue(false);
		mocks.hasPasskeyLock.mockResolvedValue(false);
		mocks.hasServerPasskeyBackup.mockResolvedValue(false);
		mocks.getServerBackupState.mockResolvedValue(
			"backup" satisfies BackupState,
		);
		mocks.enableLocalPin.mockResolvedValue(undefined);
		mocks.enablePasskey.mockResolvedValue(undefined);
	});

	it("blocks enabling the local lock without a server backup", async () => {
		mocks.getServerBackupState.mockResolvedValue("none" satisfies BackupState);
		renderPanel();
		expect(await screen.findByText("localLock.needBackup")).toBeTruthy();

		const [pin, confirm] = pinInputs();
		fireEvent.change(pin, { target: { value: "482913" } });
		fireEvent.change(confirm, { target: { value: "482913" } });
		expect(enableButton().disabled).toBe(true);

		const passkey = [...document.querySelectorAll("button")].find((item) =>
			PASSKEY_ENABLE_BUTTON.test(item.textContent ?? ""),
		);
		expect(passkey instanceof HTMLButtonElement && passkey.disabled).toBe(true);
	});

	it("enables the PIN when a usable server backup exists", async () => {
		renderPanel();
		await waitFor(() => expect(enableButton().disabled).toBe(true));
		const [pin, confirm] = pinInputs();
		fireEvent.change(pin, { target: { value: "482913" } });
		fireEvent.change(confirm, { target: { value: "482913" } });
		await waitFor(() => expect(enableButton().disabled).toBe(false));

		fireEvent.click(enableButton());
		await waitFor(() =>
			expect(mocks.enableLocalPin).toHaveBeenCalledWith("482913"),
		);
	});

	it("rejects a weak PIN even when the backup exists", async () => {
		renderPanel();
		await waitFor(() => expect(enableButton()).toBeTruthy());
		const [pin, confirm] = pinInputs();
		fireEvent.change(pin, { target: { value: "123456" } });
		fireEvent.change(confirm, { target: { value: "123456" } });
		expect(await screen.findByText("localLock.error.weakPin")).toBeTruthy();
		expect(enableButton().disabled).toBe(true);
	});

	it("explains a PIN mismatch inline", async () => {
		renderPanel();
		const [pin, confirm] = pinInputs();
		fireEvent.change(pin, { target: { value: "482913" } });
		fireEvent.change(confirm, { target: { value: "482914" } });
		expect(await screen.findByText("localLock.pinMismatch")).toBeTruthy();
		expect(enableButton().disabled).toBe(true);
	});
});
