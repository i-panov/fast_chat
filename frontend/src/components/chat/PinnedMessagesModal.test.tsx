import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Message } from "../../types/api.ts";
import { PinnedMessagesModal } from "./PinnedMessagesModal.tsx";

const UNPIN_RE = /pins\.unpin|Unpin/;

function message(overrides: Partial<Message> = {}): Message {
	return {
		id: "m1",
		chatId: "c1",
		fromId: "bob:test",
		fromNick: "bob",
		text: "pinned text",
		createdAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

describe("PinnedMessagesModal", () => {
	it("lists pinned messages and unpins", () => {
		const onUnpin = vi.fn();
		render(
			<MantineProvider>
				<PinnedMessagesModal
					open
					onClose={() => {}}
					loading={false}
					messages={[
						message(),
						message({ id: "m2", encrypted: true, text: "x" }),
					]}
					canUnpin
					onUnpin={onUnpin}
				/>
			</MantineProvider>,
		);

		expect(screen.getByText("pinned text")).toBeTruthy();
		expect(screen.getByText("pins.encrypted")).toBeTruthy();
		const buttons = screen.getAllByRole("button", {
			name: UNPIN_RE,
		});
		fireEvent.click(buttons[0]);
		expect(onUnpin).toHaveBeenCalledWith("m1");
	});
});
