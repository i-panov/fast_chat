import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeyRotationSettings } from "./KeyRotationSettings.tsx";

/* eslint-disable @typescript-eslint/no-unsafe-return -- vi.fn() doubles are untyped in these tests. */

const mocks = vi.hoisted(() => {
	class KeyPublishError extends Error {}
	class KeyBackupSaveError extends Error {}
	class LocalLockEnabledError extends Error {}
	class StaleKeyStateError extends Error {}
	class PasskeyBackupEnabledError extends Error {}
	class E2EBackupError extends Error {}
	return {
		KeyPublishError,
		KeyBackupSaveError,
		LocalLockEnabledError,
		StaleKeyStateError,
		PasskeyBackupEnabledError,
		E2EBackupError,
		hasServerPasskeyBackup: vi.fn(),
		hasLocalLock: vi.fn(),
		rotateEncryptionKey: vi.fn(),
		rotateSigningKey: vi.fn(),
	};
});

vi.mock("../../e2ee/keys.ts", () => ({
	hasLocalLock: () => mocks.hasLocalLock(),
	KeyBackupSaveError: mocks.KeyBackupSaveError,
	KeyPublishError: mocks.KeyPublishError,
	LocalLockEnabledError: mocks.LocalLockEnabledError,
	StaleKeyStateError: mocks.StaleKeyStateError,
	PasskeyBackupEnabledError: mocks.PasskeyBackupEnabledError,
	onServerBackupChanged: () => () => {},
	rotateEncryptionKey: (...args: unknown[]) =>
		mocks.rotateEncryptionKey(...args),
	rotateSigningKey: (...args: unknown[]) => mocks.rotateSigningKey(...args),
}));

vi.mock("../../e2ee/localLock.ts", () => ({
	onLocalLockChanged: () => () => {},
}));

vi.mock("../../e2ee/passkeyLock.ts", () => ({
	hasServerPasskeyBackup: (...args: unknown[]) =>
		mocks.hasServerPasskeyBackup(...args),
}));

vi.mock("../../e2ee/backup.ts", () => ({
	E2EBackupError: mocks.E2EBackupError,
}));

function renderPanel() {
	return render(
		<MantineProvider>
			<KeyRotationSettings token="tok" />
		</MantineProvider>,
	);
}

function buttons(): HTMLButtonElement[] {
	return [...document.querySelectorAll("button")].filter(
		(button): button is HTMLButtonElement =>
			button instanceof HTMLButtonElement,
	);
}

function typePassword(value: string) {
	const input = [...document.querySelectorAll("input")].find(
		(item) => item.getAttribute("type") === "password",
	);
	if (!(input instanceof HTMLInputElement)) throw new Error("no password");
	fireEvent.change(input, { target: { value } });
}

const ENCRYPTION_BUTTON = /rotation\.encryption/;

function rotateButton(): HTMLButtonElement {
	const button = buttons().find((item) =>
		ENCRYPTION_BUTTON.test(item.textContent ?? ""),
	);
	if (button === undefined) throw new Error("no rotation button");
	return button;
}

describe("KeyRotationSettings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.hasServerPasskeyBackup.mockResolvedValue(false);
		mocks.hasLocalLock.mockResolvedValue(false);
	});

	it("keeps rotation disabled until the backup state is known", () => {
		mocks.hasServerPasskeyBackup.mockReturnValue(new Promise(() => {}));
		renderPanel();
		typePassword("secret123");
		expect(rotateButton().disabled).toBe(true);
	});

	it("disables rotation when the server backup has a passkey wrapper", async () => {
		mocks.hasServerPasskeyBackup.mockResolvedValue(true);
		renderPanel();
		await screen.findByText("rotation.passkeyHint");
		typePassword("secret123");
		expect(rotateButton().disabled).toBe(true);
	});

	it("disables rotation while a local lock is enabled", async () => {
		mocks.hasLocalLock.mockResolvedValue(true);
		renderPanel();
		await screen.findByText("rotation.error.lockActive");
		typePassword("secret123");
		expect(rotateButton().disabled).toBe(true);
	});

	it("enables rotation once both checks are clean", async () => {
		renderPanel();
		await waitFor(() => expect(mocks.hasLocalLock).toHaveBeenCalled());
		typePassword("secret123");
		expect(rotateButton().disabled).toBe(false);
	});

	it("reports a publish failure", async () => {
		mocks.rotateEncryptionKey.mockRejectedValue(new mocks.KeyPublishError());
		renderPanel();
		await waitFor(() => expect(mocks.hasLocalLock).toHaveBeenCalled());
		typePassword("secret123");
		fireEvent.click(rotateButton());
		expect(await screen.findByText("rotation.error.publish")).toBeTruthy();
	});
});
