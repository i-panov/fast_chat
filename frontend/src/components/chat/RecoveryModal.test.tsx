import { MantineProvider } from "@mantine/core";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../../db/init.ts";
import { generateKeyPair, type KeyPair } from "../../e2ee/crypto.ts";
import { getMyKeyPair } from "../../e2ee/keys.ts";
import { RecoveryModal } from "./RecoveryModal.tsx";

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

const { uploadKeyBackup } = await import("../../e2ee/keys.ts");

let keys: KeyPair;

function emitRecoveryNeeded(token: string) {
	window.dispatchEvent(
		new CustomEvent("e2ee:recovery-needed", { detail: token }),
	);
}

function passwordInput(): HTMLInputElement {
	const input = [...document.querySelectorAll("input")].find(
		(el) => el.type === "password",
	);
	if (!(input instanceof HTMLInputElement))
		throw new Error("no password input");

	return input;
}

function footerButtons(): [HTMLButtonElement, HTMLButtonElement] {
	// The modal header also renders a close button; the footer pair comes last.
	const all = [...document.querySelectorAll("button")];
	const decline = all[all.length - 2];
	const recover = all[all.length - 1];
	if (
		!(decline instanceof HTMLButtonElement) ||
		!(recover instanceof HTMLButtonElement)
	) {
		throw new Error("footer buttons not found");
	}
	return [decline, recover];
}

let scopeCounter = 0;

beforeEach(async () => {
	// Fresh account scope per test: keys.ts keeps an in-memory key cache
	// that the global IDB reset does not clear.
	setActiveAccountKey(`alice-${scopeCounter++}:test`);
	backupOnServer = null;
	vi.clearAllMocks();
	keys = await generateKeyPair();
});

describe("RecoveryModal", () => {
	it("stays closed without a matching recovery event", () => {
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);

		act(() => {
			emitRecoveryNeeded("other");
		});

		expect(document.querySelectorAll("input").length).toBe(0);
	});

	it("opens on a matching recovery event", () => {
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);

		act(() => {
			emitRecoveryNeeded("tok");
		});

		expect(passwordInput()).toBeTruthy();
	});

	it("recovers the key pair with the right password", async () => {
		await uploadKeyBackup("tok", "right-pass", keys);
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.change(passwordInput(), { target: { value: "right-pass" } });
		fireEvent.click(footerButtons()[1]);

		await waitFor(async () => {
			expect(await getMyKeyPair()).toEqual(keys);
		});
	});

	it("shows an error on a wrong password", async () => {
		await uploadKeyBackup("tok", "right-pass", keys);
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.change(passwordInput(), { target: { value: "wrong-pass" } });
		fireEvent.click(footerButtons()[1]);

		await waitFor(() => {
			expect(screen.queryByText("backup.recoveryWrongPassword")).toBeTruthy();
		});
		expect(await getMyKeyPair()).toBeNull();
	});

	it("recovers on Enter", async () => {
		await uploadKeyBackup("tok", "right-pass", keys);
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.change(passwordInput(), { target: { value: "right-pass" } });
		fireEvent.keyDown(passwordInput(), { key: "Enter" });

		await waitFor(async () => {
			expect(await getMyKeyPair()).toEqual(keys);
		});
	});

	it("declining discards the backup", async () => {
		await uploadKeyBackup("tok", "right-pass", keys);
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.click(footerButtons()[0]);

		await waitFor(() => {
			expect(backupOnServer).toBeNull();
		});
		// Let the post-recovery UI settle (key save + reload) inside the
		// test lifetime so no setState outlives the jsdom teardown.
		await waitFor(() => {
			expect(footerButtons()[0].disabled).toBe(false);
		});
	});
});
