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
import { metaRepo } from "../../db/metaRepo.ts";
import { generateKeyPair, type KeyPair } from "../../e2ee/crypto.ts";
import {
	clearLocalKeys,
	getMyKeyPair,
	PASSKEY_LOCK_META,
} from "../../e2ee/keys.ts";
import { RecoveryModal } from "./RecoveryModal.tsx";

let backupOnServer: string | null = null;

vi.mock("../../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(() => ({
		publicKey: "",
		identityPublicKey: "",
		masterKeyVersion: 1,
	})),
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

function footerButton(text: string): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find(
		(item) => item.textContent === text,
	);
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`button not found: ${text}`);
	}
	return button;
}

let scopeCounter = 0;

beforeEach(async () => {
	// Fresh account scope per test: keys.ts keeps an in-memory key cache
	// that the global IDB reset does not clear.
	setActiveAccountKey(`alice-${scopeCounter++}:test`);
	backupOnServer = null;
	vi.clearAllMocks();
	vi.spyOn(window, "confirm").mockReturnValue(true);
	keys = await generateKeyPair();
	await metaRepo.setNoNotify("e2ee.publicKey", keys.publicKey);
	await metaRepo.setNoNotify("e2ee.privateKey", keys.privateKey);
	await metaRepo.setNoNotify("e2ee.keyVersion", 1);
});

// The recovery prompt is shown on a device that has no usable local key.
async function uploadAndClear(password: string) {
	await uploadKeyBackup("tok", password);
	await clearLocalKeys();
}

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
		await uploadAndClear("right-pass");
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.change(passwordInput(), { target: { value: "right-pass" } });
		fireEvent.click(footerButton("backup.recoveryRecover"));

		await waitFor(async () => {
			expect(await getMyKeyPair()).toEqual(keys);
		});
	});

	it("shows an error on a wrong password", async () => {
		await uploadAndClear("right-pass");
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.change(passwordInput(), { target: { value: "wrong-pass" } });
		fireEvent.click(footerButton("backup.recoveryRecover"));

		await waitFor(() => {
			expect(screen.queryByText("backup.recoveryWrongPassword")).toBeTruthy();
		});
		expect(await getMyKeyPair()).toBeNull();
	});

	it("recovers on Enter", async () => {
		await uploadAndClear("right-pass");
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
		await uploadAndClear("right-pass");
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.click(footerButton("backup.recoveryDecline"));

		await waitFor(() => {
			expect(backupOnServer).toBeNull();
		});
		// Let the post-recovery UI settle (key save + reload) inside the
		// test lifetime so no setState outlives the jsdom teardown.
		await waitFor(() => {
			expect(footerButton("backup.recoveryDecline").disabled).toBe(false);
		});
	});

	it("warns that recovery removes the local PIN/passkey lock", async () => {
		await metaRepo.setNoNotify(PASSKEY_LOCK_META, "{}");
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		expect(await screen.findByText("backup.recoveryRemovesLock")).toBeTruthy();
	});

	it("offers a safe way to postpone recovery", async () => {
		render(
			<MantineProvider>
				<RecoveryModal activeToken="tok" />
			</MantineProvider>,
		);
		act(() => {
			emitRecoveryNeeded("tok");
		});

		fireEvent.click(await screen.findByText("backup.recoveryLater"));
		await waitFor(() => {
			expect(document.querySelectorAll("input").length).toBe(0);
		});
	});
});
