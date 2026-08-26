import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../../db/init.ts";
import { messagesRepo } from "../../db/messagesRepo.ts";
import { useMessages } from "../../hooks/useMessages.ts";
import type { FileInfo, Message } from "../../types/api.ts";
import { MessageList } from "./MessageList.tsx";

function renderMessageList(ui: ReactElement) {
	return render(<MantineProvider>{ui}</MantineProvider>);
}

// Render Virtuoso as a plain list so item DOM order is deterministic.
vi.mock("react-virtuoso", () => ({
	Virtuoso: ({
		data,
		itemContent,
		components,
	}: {
		data: Array<{ key?: string; type: string }>;
		itemContent: (index: number, entry: unknown) => React.ReactNode;
		components?: { Header?: React.ReactNode };
	}) => (
		<div data-testid="message-list">
			{components?.Header}
			{data.map((entry, i) => (
				<div key={entry?.key ?? i} data-item-index={i}>
					{itemContent(i, entry)}
				</div>
			))}
		</div>
	),
}));

// useMessages.loadMore hits the API on mount; stub it out — ordering
// comes from the local cache, not the network.
vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();
	return {
		...actual,
		getMessages: () => Promise.resolve({ messages: [], nextCursor: null }),
	};
});

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../i18n.ts", () => ({
	default: {
		t: (key: string) => key,
	},
	getCurrentLocale: () => "ru",
}));

vi.mock("../../useAuth.tsx", () => ({
	useAuth: () => ({
		activeAccount: {
			token: "test-token",
			user: { id: "alice:test", nick: "alice" },
		},
	}),
}));

function msg(
	id: string,
	createdAt: string,
	text: string,
	files?: FileInfo[],
): Message {
	return {
		id,
		chatId: "chat-1",
		fromId: "alice:test",
		fromNick: "alice",
		text,
		createdAt,
		files,
	};
}

const FILE_INFO: FileInfo = {
	id: "file-1",
	mimeType: "application/pdf",
	size: 1024,
	originalName: "doc.pdf",
	fileType: "file",
	url: "/api/files/file-1",
};

function MessagesHarness() {
	const { messages } = useMessages({ token: "test-token", chatId: "chat-1" });

	return (
		<MessageList
			messages={messages}
			userId="alice:test"
			chatId="chat-1"
			token="test-token"
			onDelete={() => {}}
			onStartEdit={() => {}}
			editTTL={300}
			deleteTTL={300}
		/>
	);
}

beforeEach(async () => {
	setActiveAccountKey("alice:test");
});

describe("MessageList ordering", () => {
	it("renders a message sent in the same second as previous ones as the last row", async () => {
		// Server (RFC3339Nano) message at exact second, and a newer
		// client (toISOString) message at 973ms of the same second.
		const older = msg("old-msg", "2026-08-26T14:45:09Z", "old message");
		const newer = msg("new-msg", "2026-08-26T14:45:09.973Z", "new message");

		await messagesRepo.upsertMany([newer, older]);

		renderMessageList(<MessagesHarness />);

		await screen.findByText("new message");

		const rows = screen.getAllByText(/old message|new message/);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toHaveTextContent("old message");
		expect(rows[1]).toHaveTextContent("new message");
	});
});

describe("MessageList attachment-only messages", () => {
	it("still renders a timestamp for a file-only message", async () => {
		const fileOnly = msg("file-msg", "2026-08-26T14:45:09.973Z", "", [
			FILE_INFO,
		]);

		await messagesRepo.upsertMany([fileOnly]);

		renderMessageList(<MessagesHarness />);

		await screen.findByText("doc.pdf");

		const bubble = document.querySelector('[data-message-id="file-msg"]');
		expect(bubble).not.toBeNull();
		expect(bubble?.textContent).toMatch(/\d{1,2}:\d{2}/);
	});
});
