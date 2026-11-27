import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AdminChat, ApiError, adminListMessages } from "../../api.ts";
import type { Message } from "../../types/api.ts";
import { MessagesTab } from "./MessagesTab.tsx";

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();

	return {
		...actual,
		adminListMessages: vi.fn(),
		adminDeleteMessage: vi.fn(),
	};
});

const { adminDeleteMessage } = await import("../../api.ts");

const DELETE_BUTTON_RE = /admin\.delete:/;

const t = ((key: string) => key) as unknown as TFunction;

function adminChat(id: string, name: string): AdminChat {
	return {
		id,
		type: "group",
		name,
		ownerId: "alice:test",
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function message(id: string, chatId: string, text: string): Message {
	return {
		id,
		chatId,
		fromId: "bob:test",
		fromNick: "bob",
		text,
		createdAt: "2026-01-01T00:00:00Z",
	};
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});

	return { promise, resolve };
}

function renderTab(chat: AdminChat | null) {
	return render(
		<MantineProvider>
			<MessagesTab token="tok" chat={chat} ask={() => {}} t={t} />
		</MantineProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("admin MessagesTab", () => {
	it("does not show the previous chat's messages while the next loads", async () => {
		vi.mocked(adminListMessages).mockResolvedValueOnce({
			messages: [message("m1", "a", "from A")],
			hasMore: true,
			nextCursor: "cursor-a",
		});
		const pendingB = deferred<{
			messages: Message[];
			hasMore: boolean;
			nextCursor?: string;
		}>();
		vi.mocked(adminListMessages).mockReturnValueOnce(pendingB.promise);

		const { rerender } = renderTab(adminChat("a", "Alpha"));
		await screen.findByText("from A");
		expect(screen.getByText("admin.loadMore")).toBeTruthy();

		rerender(
			<MantineProvider>
				<MessagesTab
					token="tok"
					chat={adminChat("b", "Beta")}
					ask={() => {}}
					t={t}
				/>
			</MantineProvider>,
		);

		await waitFor(() => {
			expect(screen.queryByText("from A")).toBeNull();
		});
		expect(screen.queryByText("admin.loadMore")).toBeNull();

		pendingB.resolve({
			messages: [message("m2", "b", "from B")],
			hasMore: false,
		});
		expect(await screen.findByText("from B")).toBeTruthy();
	});

	it("ignores a late response for a chat that is no longer selected", async () => {
		const pendingA = deferred<{
			messages: Message[];
			hasMore: boolean;
		}>();
		vi.mocked(adminListMessages).mockReturnValueOnce(pendingA.promise);
		vi.mocked(adminListMessages).mockResolvedValueOnce({
			messages: [message("m2", "b", "from B")],
			hasMore: false,
		});

		const { rerender } = renderTab(adminChat("a", "Alpha"));
		rerender(
			<MantineProvider>
				<MessagesTab
					token="tok"
					chat={adminChat("b", "Beta")}
					ask={() => {}}
					t={t}
				/>
			</MantineProvider>,
		);
		expect(await screen.findByText("from B")).toBeTruthy();

		pendingA.resolve({
			messages: [message("m1", "a", "from A")],
			hasMore: true,
		});

		await waitFor(() => {
			expect(screen.queryByText("from A")).toBeNull();
		});
	});

	it("deletes a message only after confirmation and reports a refusal", async () => {
		vi.mocked(adminListMessages).mockResolvedValue({
			messages: [message("m1", "a", "from A")],
			hasMore: false,
		});
		vi.mocked(adminDeleteMessage).mockRejectedValue(
			new ApiError(403, "http 403: forbidden"),
		);
		const ask = vi.fn();

		render(
			<MantineProvider>
				<MessagesTab
					token="tok"
					chat={adminChat("a", "Alpha")}
					ask={ask}
					t={t}
				/>
			</MantineProvider>,
		);

		expect(await screen.findByText("from A")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: DELETE_BUTTON_RE }));

		expect(ask).toHaveBeenCalledTimes(1);
		expect(adminDeleteMessage).not.toHaveBeenCalled();
	});
});
