import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BotsModal } from "./BotsModal.tsx";

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();

	return {
		...actual,
		createBot: vi.fn(),
		listBots: vi.fn(),
		rotateBotToken: vi.fn(),
	};
});

const { createBot, listBots } = await import("../../api.ts");

const CREATE_BUTTON_RE = /bots\.create|Create bot/;

const BOT = {
	id: "helper_bot:test",
	username: "helper_bot",
	displayName: "Helper",
	ownerId: "alice:test",
	ownerUsername: "alice",
	encryptionMode: "server",
	isActive: true,
	isMaster: false,
};

function renderModal(open: boolean, token: string | undefined) {
	return render(
		<MantineProvider>
			<BotsModal open={open} onClose={() => {}} token={token} />
		</MantineProvider>,
	);
}

function tokenInput(): HTMLInputElement {
	const input = [...document.querySelectorAll("input")].find(
		(el) => el.getAttribute("placeholder") === "my_bot",
	);
	if (!(input instanceof HTMLInputElement))
		throw new Error("no username input");

	return input;
}

function createButton(): HTMLButtonElement {
	const button = [...document.querySelectorAll("button")].find((b) =>
		CREATE_BUTTON_RE.test(b.textContent ?? ""),
	);
	if (!(button instanceof HTMLButtonElement)) throw new Error("no create");

	return button;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(listBots).mockResolvedValue({ ok: true, result: [] });
	vi.mocked(createBot).mockResolvedValue({
		ok: true,
		bot: BOT,
		token: "secret-token",
	});
});

describe("BotsModal", () => {
	it("requires the _bot suffix before creating", () => {
		renderModal(true, "tok");

		expect(createButton().disabled).toBe(true);
		fireEvent.change(tokenInput(), { target: { value: "helper" } });
		expect(createButton().disabled).toBe(true);
		fireEvent.change(tokenInput(), { target: { value: "helper_bot" } });
		expect(createButton().disabled).toBe(false);
	});

	it("shows the issued token once and forgets it after closing", async () => {
		const { rerender } = renderModal(true, "tok");
		await screen.findByText("bots.empty");

		fireEvent.change(tokenInput(), { target: { value: "helper_bot" } });
		fireEvent.click(createButton());

		expect(await screen.findByText("secret-token")).toBeTruthy();

		rerender(
			<MantineProvider>
				<BotsModal open={false} onClose={() => {}} token="tok" />
			</MantineProvider>,
		);
		rerender(
			<MantineProvider>
				<BotsModal open onClose={() => {}} token="tok" />
			</MantineProvider>,
		);

		await waitFor(() => {
			expect(screen.queryByText("secret-token")).toBeNull();
		});
	});

	it("drops the token when the account changes", async () => {
		const { rerender } = renderModal(true, "tok");
		await screen.findByText("bots.empty");

		fireEvent.change(tokenInput(), { target: { value: "helper_bot" } });
		fireEvent.click(createButton());
		expect(await screen.findByText("secret-token")).toBeTruthy();

		rerender(
			<MantineProvider>
				<BotsModal open onClose={() => {}} token="tok2" />
			</MantineProvider>,
		);

		await waitFor(() => {
			expect(screen.queryByText("secret-token")).toBeNull();
		});
	});

	it("copies the token", async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		renderModal(true, "tok");
		await screen.findByText("bots.empty");

		fireEvent.change(tokenInput(), { target: { value: "helper_bot" } });
		fireEvent.click(createButton());
		await screen.findByText("secret-token");

		fireEvent.click(screen.getByText("bots.copy"));
		await waitFor(() => {
			expect(writeText).toHaveBeenCalledWith("secret-token");
		});
		expect(await screen.findByText("bots.copied")).toBeTruthy();
	});

	it("does not claim the list is empty when loading failed", async () => {
		vi.mocked(listBots).mockRejectedValue(new Error("http 500"));
		renderModal(true, "tok");

		expect(await screen.findByRole("alert")).toBeTruthy();
		expect(screen.queryByText("bots.empty")).toBeNull();
	});
});
