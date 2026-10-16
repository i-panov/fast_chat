import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as React from "react";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../../db/init.ts";
import { messagesRepo } from "../../db/messagesRepo.ts";
import type { Message } from "../../types/api.ts";
import { MessageList } from "./MessageList.tsx";

const scrollToIndex = vi.fn(
	(_opts: { index: number; align: string }): void => {},
);

const virtuosoPropsHolder: {
	current: {
		rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
		startReached?: () => void;
	};
} = { current: {} };

vi.mock("react-virtuoso", () => ({
	Virtuoso: forwardRef(function MockVirtuoso(
		props: {
			data: unknown[];
			itemContent: (index: number, entry: unknown) => React.ReactNode;
			components?: { Header?: React.ReactNode };
			rangeChanged?: (range: { startIndex: number; endIndex: number }) => void;
			startReached?: () => void;
		},
		ref: React.Ref<{
			scrollToIndex: (opts: { index: number; align: string }) => void;
		}>,
	) {
		const rangeChangedRef = useRef(props.rangeChanged);
		rangeChangedRef.current = props.rangeChanged;
		const dataRef = useRef(props.data);
		dataRef.current = props.data;
		useImperativeHandle(ref, () => ({
			scrollToIndex: (opts: { index: number; align: string }) => {
				scrollToIndex(opts);
			},
		}));
		useEffect(() => {
			rangeChangedRef.current?.({
				startIndex: 0,
				endIndex: Math.max(0, dataRef.current.length - 1),
			});
		}, []);
		virtuosoPropsHolder.current = props;
		const Header = props.components?.Header as React.ComponentType | undefined;
		return (
			<div data-testid="message-list">
				{Header ? <Header /> : null}
				{props.data.map((entry, i) => {
					const key =
						typeof entry === "object" &&
						entry !== null &&
						"key" in entry &&
						typeof entry.key === "string"
							? entry.key
							: i;
					return (
						<div key={key} data-item-index={i}>
							{props.itemContent(i, entry)}
						</div>
					);
				})}
			</div>
		);
	}),
}));

vi.mock("../../api.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../api.ts")>();
	return {
		...actual,
		getMessages: () => Promise.resolve({ messages: [], nextCursor: null }),
		markMessagesRead: vi.fn(() => Promise.resolve({ status: "ok" })),
	};
});

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../i18n.ts", () => ({
	default: { t: (key: string) => key },
	getCurrentLocale: () => "en-US",
}));

vi.mock("../../useAuth.tsx", () => ({
	useAuth: () => ({
		activeAccount: {
			token: "test-token",
			user: { id: "alice:test", nick: "alice" },
		},
	}),
}));

const { markMessagesRead } = await import("../../api.ts");

function msg(
	id: string,
	fromId = "bob:test",
	extra: Partial<Message> = {},
): Message {
	return {
		id,
		chatId: "chat-1",
		fromId,
		fromNick: fromId === "alice:test" ? "alice" : "bob",
		text: `text ${id}`,
		createdAt: "2026-01-01T00:00:00Z",
		...extra,
	};
}

function renderList(props: Partial<React.ComponentProps<typeof MessageList>>) {
	return render(
		<MantineProvider>
			<MessageList
				messages={[]}
				userId="alice:test"
				chatId="chat-1"
				token="test-token"
				onDelete={() => {}}
				onStartEdit={() => {}}
				editTTL={300}
				deleteTTL={300}
				{...props}
			/>
		</MantineProvider>,
	);
}

const scrollIntoView = vi.fn();

beforeEach(() => {
	setActiveAccountKey("alice:test");
	vi.clearAllMocks();
	Object.defineProperty(window.Element.prototype, "scrollIntoView", {
		value: scrollIntoView,
		configurable: true,
		writable: true,
	});
});

describe("message list chrome", () => {
	it("shows the loading header", () => {
		renderList({ messages: [msg("m1")], isLoadingMore: true });

		expect(screen.getByText("chat.loading")).toBeTruthy();
	});

	it("shows offline and online empty states", () => {
		const { unmount } = renderList({ isOffline: true });
		expect(screen.getByText("chat.offlineNoMessages")).toBeTruthy();
		unmount();

		renderList({});
		expect(screen.getByText("chat.noMessages")).toBeTruthy();
	});
});

describe("message list paging and read receipts", () => {
	it("loads more at the top edge", () => {
		const onLoadMore = vi.fn();
		renderList({ messages: [msg("m1")], hasMore: true, onLoadMore });

		virtuosoPropsHolder.current.startReached?.();

		expect(onLoadMore).toHaveBeenCalledTimes(1);
	});

	it("does not load while loading or exhausted", () => {
		const onLoadMore = vi.fn();
		const { unmount } = renderList({
			messages: [msg("m1")],
			hasMore: true,
			isLoadingMore: true,
			onLoadMore,
		});
		virtuosoPropsHolder.current.startReached?.();
		unmount();

		renderList({ messages: [msg("m1")], hasMore: false, onLoadMore });
		virtuosoPropsHolder.current.startReached?.();

		expect(onLoadMore).not.toHaveBeenCalled();
	});

	it("marks visible unread messages as read", async () => {
		await messagesRepo.upsertMany([
			msg("unread-1"),
			msg("own", "alice:test"),
			msg("read-1", "bob:test", { deliveryStatus: "read" }),
		]);
		renderList({
			messages: [
				msg("unread-1"),
				msg("own", "alice:test"),
				msg("read-1", "bob:test", { deliveryStatus: "read" }),
			],
		});

		await waitFor(() => {
			expect(markMessagesRead).toHaveBeenCalledWith("test-token", "chat-1", [
				"unread-1",
			]);
		});
	});
});

describe("message list scrolling", () => {
	it("scrolls to a message in range", async () => {
		await messagesRepo.upsertMany([msg("m1"), msg("m2")]);
		renderList({ messages: [msg("m1"), msg("m2")], scrollToMessageId: "m2" });

		await waitFor(() => {
			expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, align: "center" });
		});
	});

	it("ignores unknown scroll targets", async () => {
		renderList({ messages: [msg("m1")], scrollToMessageId: "missing" });

		await new Promise((r) => setTimeout(r, 200));
		expect(scrollToIndex).not.toHaveBeenCalled();
	});

	it("jumps to the replied message on preview click", async () => {
		await messagesRepo.upsertMany([
			msg("parent"),
			msg("child", "alice:test", {
				replyTo: { messageId: "parent", text: "parent", fromNick: "bob" },
			}),
		]);
		renderList({
			messages: [
				msg("parent"),
				msg("child", "alice:test", {
					replyTo: { messageId: "parent", text: "parent", fromNick: "bob" },
				}),
			],
		});

		const preview = await screen.findByText("parent");
		const callsBefore = scrollIntoView.mock.calls.length;
		fireEvent.click(preview);

		await waitFor(() => {
			expect(scrollIntoView.mock.calls.length).toBeGreaterThan(callsBefore);
		});
	});
});
