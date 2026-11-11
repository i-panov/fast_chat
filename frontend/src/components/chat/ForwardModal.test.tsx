import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Chat, Message } from "../../types/api.ts";
import { ForwardModal } from "./ForwardModal.tsx";

const chat: Chat = {
	id: "c2",
	type: "group",
	name: "Target",
	ownerId: "alice:test",
	members: [{ id: "alice:test", nick: "alice" }],
	createdAt: "2026-01-01T00:00:00Z",
};
const message: Message = {
	id: "m1",
	chatId: "c1",
	fromId: "bob:test",
	fromNick: "bob",
	text: "forwarded text",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("ForwardModal", () => {
	it("forwards to the selected chat", () => {
		const onForward = vi.fn();
		render(
			<MantineProvider>
				<ForwardModal
					open
					onClose={() => {}}
					chats={[chat]}
					userId="alice:test"
					message={message}
					onForward={onForward}
				/>
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Target" }));
		expect(onForward).toHaveBeenCalledWith("c2");
	});
});
