import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../../db/init.ts";
import { generateKeyPair, type KeyPair } from "../../e2ee/crypto.ts";
import { BackupSettingsModal } from "./BackupSettingsModal.tsx";

let backupOnServer: string | null = null;

vi.mock("../../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(),
	getKeyBackup: vi.fn(() => {
		if (backupOnServer === null) throw new Error("http 404: no key backup");
		return { backup: backupOnServer };
	}),
	setKeyBackup: vi.fn((_token: string, backup: string) => {
		backupOnServer = backup;
	}),
	deleteKeyBackup: vi.fn(() => {
		backupOnServer = null;
	}),
}));

const DELETE_BUTTON = /backup\.delete|Delete/;
const CLOSE_BUTTON = /backup\.close|Close/;
const NEED_LOCAL_KEY = /backup\.needLocalKey|need/i;

let scopeCounter = 0;
let keys: KeyPair;

function passwords(): HTMLInputElement[] {
	return [...document.querySelectorAll("input")].filter(
		(el): el is HTMLInputElement =>
			el instanceof HTMLInputElement && el.type === "password",
	);
}

function typePassword(value: string) {
	for (const input of passwords()) {
		fireEvent.change(input, { target: { value } });
	}
}

function saveButton(): HTMLButtonElement {
	const buttons = [...document.querySelectorAll("button")];
	const save = buttons[buttons.length - 1];
	if (!(save instanceof HTMLButtonElement)) throw new Error("no save button");

	return save;
}

beforeEach(async () => {
	setActiveAccountKey(`alice-${scopeCounter++}:test`);
	backupOnServer = null;
	vi.clearAllMocks();
	keys = await generateKeyPair();
});

describe("backup settings modal", () => {
	it("renders nothing when closed", () => {
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={false}
					onClose={() => {}}
					token="tok"
					keyPair={keys}
				/>
			</MantineProvider>,
		);

		expect(passwords().length).toBe(0);
	});

	it("saves a new backup", async () => {
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={true}
					onClose={() => {}}
					token="tok"
					keyPair={keys}
				/>
			</MantineProvider>,
		);

		typePassword("secret123");
		expect(saveButton().disabled).toBe(false);
		fireEvent.click(saveButton());

		await waitFor(() => {
			expect(backupOnServer).not.toBeNull();
		});
		// Inputs are cleared after a successful save.
		expect(passwords().every((i) => i.value === "")).toBe(true);
	});

	it("keeps save disabled for short or mismatched passwords", () => {
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={true}
					onClose={() => {}}
					token="tok"
					keyPair={keys}
				/>
			</MantineProvider>,
		);

		typePassword("short");
		expect(saveButton().disabled).toBe(true);
	});

	it("shows the delete option when a backup exists", async () => {
		backupOnServer = "opaque-blob";
		const onClose = vi.fn();
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={true}
					onClose={onClose}
					token="tok"
					keyPair={keys}
				/>
			</MantineProvider>,
		);

		const deleteBtn = await screen.findByText(DELETE_BUTTON);
		fireEvent.click(deleteBtn);

		await waitFor(() => {
			expect(backupOnServer).toBeNull();
		});
		fireEvent.click(screen.getByText(CLOSE_BUTTON));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("shows an error when saving fails", async () => {
		const { setKeyBackup } = await import("../../api.ts");
		vi.mocked(setKeyBackup).mockRejectedValueOnce(new Error("denied"));
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={true}
					onClose={() => {}}
					token="tok"
					keyPair={keys}
				/>
			</MantineProvider>,
		);

		typePassword("secret123");
		fireEvent.click(saveButton());

		await waitFor(() => {
			expect(backupOnServer).toBeNull();
		});
		expect(await screen.findByText("denied")).toBeTruthy();
	});

	it("warns without a local key pair", () => {
		render(
			<MantineProvider>
				<BackupSettingsModal
					open={true}
					onClose={() => {}}
					token="tok"
					keyPair={null}
				/>
			</MantineProvider>,
		);

		expect(screen.queryByText(NEED_LOCAL_KEY)).toBeTruthy();
		expect(saveButton().disabled).toBe(true);
	});
});
