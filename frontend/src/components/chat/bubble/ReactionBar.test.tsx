import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionBar } from "./ReactionBar.tsx";

vi.mock("../../../api.ts", () => ({
	addMessageReaction: vi.fn(),
	removeMessageReaction: vi.fn(),
}));

vi.mock("../../../useAuth.tsx", () => ({
	useAuth: () => ({ activeAccount: { token: "tok" } }),
}));

const { addMessageReaction, removeMessageReaction } = await import(
	"../../../api.ts"
);

const ADD_REACTION_RE = /reaction\.add|Add reaction/;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("ReactionBar", () => {
	it("adds a reaction from the picker", async () => {
		vi.mocked(addMessageReaction).mockResolvedValue({
			reactions: [{ emoji: "❤️", count: 1, me: true }],
		});

		render(
			<MantineProvider>
				<ReactionBar
					chatId="c1"
					messageId="m1"
					reactions={[{ emoji: "👍", count: 2, me: false }]}
				/>
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: ADD_REACTION_RE }));
		fireEvent.click(await screen.findByRole("button", { name: "❤️" }));

		await waitFor(() => {
			expect(addMessageReaction).toHaveBeenCalledWith("tok", "c1", "m1", "❤️");
		});
		expect(await screen.findByRole("button", { name: "❤️ 1" })).toBeTruthy();
	});

	it("removes an existing own reaction", async () => {
		vi.mocked(removeMessageReaction).mockResolvedValue({ reactions: [] });

		render(
			<MantineProvider>
				<ReactionBar
					chatId="c1"
					messageId="m1"
					reactions={[{ emoji: "👍", count: 1, me: true }]}
				/>
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "👍 1" }));

		await waitFor(() => {
			expect(removeMessageReaction).toHaveBeenCalledWith(
				"tok",
				"c1",
				"m1",
				"👍",
			);
		});
	});
});
