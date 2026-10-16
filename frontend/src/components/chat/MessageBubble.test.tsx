import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../useAuth.tsx";
import { MessageBubble } from "./MessageBubble.tsx";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../i18n.ts", () => ({
	default: { t: (key: string) => key },
	getCurrentLocale: () => "en-US",
}));

vi.mock("../../useAuth.tsx", () => ({
	AuthProvider: ({ children }: { children: React.ReactNode }) => (
		<>{children}</>
	),
	useAuth: () => ({
		activeAccount: {
			token: "tok",
			user: { id: "alice:test", nick: "alice" },
		},
	}),
}));

vi.mock("react-leaflet", () => ({
	MapContainer: ({ children }: { children: React.ReactNode }) => (
		<div data-testid="map">{children}</div>
	),
	Marker: () => null,
	TileLayer: () => null,
	useMap: () => ({ setView: () => {}, getZoom: () => 15 }),
	useMapEvents: () => {},
}));

const COPY_TEXT = "message.copy";
const EDIT_TEXT = "message.edit";
const REPLY_TEXT = "message.reply";
const DELETE_TEXT = "message.delete";
const RETRY_TEXT = "message.retry";
const CANCEL_SEND_TEXT = "message.cancelSend";
const CREATE_THREAD_TEXT = "message.createThread";

function bubbleProps(
	overrides: Partial<React.ComponentProps<typeof MessageBubble>> = {},
): React.ComponentProps<typeof MessageBubble> {
	return {
		text: "hello",
		isOwn: true,
		fromNick: "alice",
		time: "12:00",
		chatId: "c1",
		msgId: "m1",
		createdAt: new Date().toISOString(),
		onReplyClick: () => {},
		onStartEdit: () => {},
		onDelete: () => {},
		editTTL: 300,
		deleteTTL: 300,
		...overrides,
	};
}

function renderBubble(props: React.ComponentProps<typeof MessageBubble>) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<MessageBubble {...props} />
			</AuthProvider>
		</MantineProvider>,
	);
}

async function openMenu() {
	const paper = document.querySelector('[data-message-id="m1"]');
	if (!paper) throw new Error("no bubble");
	fireEvent.contextMenu(paper, { clientX: 10, clientY: 10 });

	await screen.findByText(COPY_TEXT);
}

const writeText = vi.fn(() => Promise.resolve());

beforeEach(() => {
	vi.clearAllMocks();
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
});

describe("message bubble", () => {
	it("renders the author, text and message id", () => {
		renderBubble(bubbleProps({ isOwn: false, showAuthorNick: true }));

		expect(document.body.textContent).toContain("@alice");
		expect(screen.getByText("hello")).toBeTruthy();
		expect(document.body.textContent).toContain("@alice");
		expect(document.querySelector('[data-message-id="m1"]')).toBeTruthy();
	});

	it("edits from the context menu", async () => {
		const onStartEdit = vi.fn();
		renderBubble(bubbleProps({ onStartEdit }));

		await openMenu();
		fireEvent.click(screen.getByText(EDIT_TEXT));

		expect(onStartEdit).toHaveBeenCalledWith(
			"c1",
			"m1",
			"hello",
			undefined,
			undefined,
		);
	});

	it("deletes from the context menu", async () => {
		const onDelete = vi.fn();
		renderBubble(bubbleProps({ onDelete }));

		await openMenu();
		fireEvent.click(screen.getByText(DELETE_TEXT));

		expect(onDelete).toHaveBeenCalledWith("c1", "m1");
	});

	it("replies and creates threads from the menu", async () => {
		const onReply = vi.fn();
		const onCreateThread = vi.fn();
		renderBubble(bubbleProps({ onReply, onCreateThread, status: "sent" }));

		await openMenu();
		fireEvent.click(screen.getByText(REPLY_TEXT));
		expect(onReply).toHaveBeenCalledWith("c1", "m1");

		await openMenu();
		fireEvent.click(screen.getByText(CREATE_THREAD_TEXT));
		expect(onCreateThread).toHaveBeenCalledWith("c1", "m1");
	});

	it("retries failed and cancels queued sends", async () => {
		const onRetry = vi.fn();
		const onCancelSend = vi.fn();
		renderBubble(bubbleProps({ status: "failed", onRetry, onCancelSend }));

		await openMenu();
		fireEvent.click(screen.getByText(RETRY_TEXT));
		expect(onRetry).toHaveBeenCalledWith("c1", "m1");
	});

	it("cancels a queued send from the menu", async () => {
		const onCancelSend = vi.fn();
		renderBubble(bubbleProps({ status: "queued", onCancelSend }));

		await openMenu();
		fireEvent.click(screen.getByText(CANCEL_SEND_TEXT));
		expect(onCancelSend).toHaveBeenCalledWith("c1", "m1");
	});

	it("copies the text", async () => {
		renderBubble(bubbleProps({}));

		await openMenu();
		fireEvent.click(screen.getByText(COPY_TEXT));

		expect(writeText).toHaveBeenCalledWith("hello");
	});

	it("closes the menu after an action", async () => {
		renderBubble(bubbleProps({ onStartEdit: () => {} }));

		await openMenu();
		expect(screen.queryByText(EDIT_TEXT)).toBeTruthy();
		fireEvent.click(screen.getByText(EDIT_TEXT));
		await waitFor(() => {
			expect(screen.queryByText(EDIT_TEXT)).toBeNull();
		});
	});

	it("hides edit for expired messages", async () => {
		renderBubble(
			bubbleProps({ createdAt: "2020-01-01T00:00:00Z", status: "sent" }),
		);

		await openMenu();
		expect(screen.queryByText(EDIT_TEXT)).toBeNull();
		expect(screen.queryByText(DELETE_TEXT)).toBeNull();
	});

	it("opens the thread on link click", () => {
		const onOpenThread = vi.fn();
		renderBubble(
			bubbleProps({ threadId: "th1", threadMessageCount: 3, onOpenThread }),
		);

		const threadLink = [...document.querySelectorAll("button")].find(
			(b) => b.textContent === "3",
		);
		if (!threadLink) throw new Error("no thread link");
		fireEvent.click(threadLink);
		expect(onOpenThread).toHaveBeenCalledWith("th1");
	});

	it("opens the photo lightbox on click", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["pic"])))),
		);
		renderBubble(
			bubbleProps({
				text: "",
				files: [
					{
						id: "f1",
						mimeType: "image/png",
						size: 10,
						originalName: "a.png",
						fileType: "photo",
						url: "https://srv/f/1",
					},
				],
			}),
		);

		const img = await screen.findByAltText("a.png");
		fireEvent.click(img);

		expect(await screen.findByAltText("a.png")).toBeTruthy();
		vi.unstubAllGlobals();
	});

	it("opens the location lightbox", () => {
		renderBubble(bubbleProps({ location: { lat: 10, lng: 20 } }));

		expect(screen.getByText("10.000000, 20.000000")).toBeTruthy();
	});
});
