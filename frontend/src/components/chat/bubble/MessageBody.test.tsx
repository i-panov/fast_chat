import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageBody } from "./MessageBody.tsx";

const EDITED_PATTERN = /edited|message\.edited/;
const QUEUED_LABEL = /Queued|message\.queued/;
const FAILED_TITLE = /Failed to send|message\.failed/;
const PLAIN_ICON = /Not encrypted|message\.notEncrypted/;
const UNDECRYPTABLE_TITLE =
	/Message cannot be decrypted|message\.undecryptable/;

function renderBody(props: Partial<React.ComponentProps<typeof MessageBody>>) {
	return render(
		<MantineProvider>
			<MessageBody text="" time="12:00" locale="en-US" {...props} />
		</MantineProvider>,
	);
}

const writeText = vi.fn(() => Promise.resolve());

function stubClipboard() {
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	stubClipboard();
});

describe("message body", () => {
	it("renders an attachment-only stub with time", () => {
		renderBody({ text: "" });

		expect(screen.getByText("12:00")).toBeTruthy();
	});

	it("shows queued and failed states", () => {
		const { unmount } = renderBody({ text: "", status: "queued" });
		expect(screen.getByLabelText(QUEUED_LABEL)).toBeTruthy();
		unmount();

		renderBody({ text: "", status: "failed" });
		expect(screen.getByTitle(FAILED_TITLE)).toBeTruthy();
	});

	it("shows the edited time", () => {
		renderBody({ text: "hi", editedAt: "2026-01-01T12:34:00Z" });

		expect(screen.getByText(EDITED_PATTERN)).toBeTruthy();
	});

	it("marks plaintext with an open lock", () => {
		renderBody({ text: "hi", encrypted: false });

		expect(screen.getByLabelText(PLAIN_ICON)).toBeTruthy();
	});

	it("hides the lock for encrypted messages", () => {
		renderBody({ text: "hi", encrypted: true });

		expect(screen.queryByLabelText(PLAIN_ICON)).toBeNull();
	});

	it("renders undecryptable text in a locked box", () => {
		renderBody({ text: "???", encrypted: true, undecryptable: true });

		expect(screen.getByTitle(UNDECRYPTABLE_TITLE)).toBeTruthy();
		expect(screen.getByText("???")).toBeTruthy();
	});

	it("renders markdown links", () => {
		renderBody({ text: "see [docs](https://example.com/x)" });

		const link = screen.getByText("docs").closest("a");
		expect(link?.getAttribute("href")).toBe("https://example.com/x");
		expect(link?.getAttribute("target")).toBe("_blank");
	});

	it("renders inline code", () => {
		renderBody({ text: "run `npm test` now" });

		expect(screen.getByText("npm test").tagName).toBe("CODE");
	});

	it("renders fenced blocks with copy", () => {
		renderBody({ text: "```js\nconst a = 1;\n```" });

		expect(screen.getByText("js")).toBeTruthy();
		const copy = document.querySelectorAll("button")[0];
		fireEvent.click(copy);

		expect(writeText).toHaveBeenCalledWith("const a = 1;\n");
	});

	it("shows delivery status for own messages", () => {
		const { container } = renderBody({
			text: "hi",
			isOwn: true,
			deliveryStatus: "read",
		});

		expect(container.querySelector(".message-status-read")).toBeTruthy();
	});
});
