import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../../db/init.ts";
import { metaRepo } from "../../db/metaRepo.ts";
import { generateKeyPair } from "../../e2ee/crypto.ts";
import { BackupSetupGate } from "./BackupSetupGate.tsx";

let serverBackup: string | null = null;
let failSave = true;

vi.mock("../../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(() => ({
		publicKey: "",
		identityPublicKey: "",
		masterKeyVersion: 1,
	})),
	getKeyBackup: vi.fn(() => {
		if (serverBackup === null) throw new Error("http 404: no key backup");
		return { backup: serverBackup };
	}),
	setKeyBackup: vi.fn((_token: string, backup: string) => {
		if (failSave) throw new Error("network down");
		serverBackup = backup;
	}),
	deleteKeyBackup: vi.fn(() => {
		serverBackup = null;
	}),
	getSessions: vi.fn(() =>
		Promise.resolve({ currentSessionId: "s1", sessions: [] }),
	),
}));

const SAVE = /backup\.(save|change)/;
const CONTINUE = "backup.continueWithout";

let counter = 0;

describe("BackupSetupGate", () => {
	beforeEach(async () => {
		setActiveAccountKey(`gate-${counter++}:test`);
		sessionStorage.clear();
		serverBackup = null;
		failSave = true;
		vi.clearAllMocks();
		vi.spyOn(window, "confirm").mockReturnValue(true);
		const keys = await generateKeyPair();
		await metaRepo.setNoNotify("e2ee.publicKey", keys.publicKey);
		await metaRepo.setNoNotify("e2ee.privateKey", keys.privateKey);
		await metaRepo.setNoNotify("e2ee.keyVersion", 1);
		await metaRepo.setNoNotify("e2ee.publicKeyUploaded", true);
	});

	it("keeps the gate closed after 'continue without a backup' and an online event", async () => {
		render(
			<MantineProvider>
				<BackupSetupGate activeToken="tok" />
			</MantineProvider>,
		);
		await screen.findByRole("dialog");

		const passwords = [...document.querySelectorAll("input")].filter(
			(el) => el.getAttribute("type") === "password",
		);
		for (const input of passwords) {
			fireEvent.change(input, { target: { value: "secret123" } });
		}
		const save = [...document.querySelectorAll("button")].find((button) =>
			SAVE.test(button.textContent ?? ""),
		);
		if (!(save instanceof HTMLButtonElement)) throw new Error("no save");
		fireEvent.click(save);

		const escapeButton = await screen.findByText(CONTINUE);
		fireEvent.click(escapeButton);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		window.dispatchEvent(new Event("online"));
		await new Promise((resolve) => {
			setTimeout(resolve, 50);
		});
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("reopens for a different token after a dismissal", async () => {
		const view = render(
			<MantineProvider>
				<BackupSetupGate activeToken="tok" />
			</MantineProvider>,
		);
		await screen.findByRole("dialog");
		const passwords = [...document.querySelectorAll("input")].filter(
			(el) => el.getAttribute("type") === "password",
		);
		for (const input of passwords) {
			fireEvent.change(input, { target: { value: "secret123" } });
		}
		const save = [...document.querySelectorAll("button")].find((button) =>
			SAVE.test(button.textContent ?? ""),
		);
		if (!(save instanceof HTMLButtonElement)) throw new Error("no save");
		fireEvent.click(save);
		fireEvent.click(await screen.findByText(CONTINUE));
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).toBeNull();
		});

		view.rerender(
			<MantineProvider>
				<BackupSetupGate activeToken="tok-2" />
			</MantineProvider>,
		);
		await waitFor(() => {
			expect(screen.queryByRole("dialog")).not.toBeNull();
		});
	});
});
