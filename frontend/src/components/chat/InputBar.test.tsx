import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileInfo, PendingFile } from "../../types/api.ts";
import { AuthProvider } from "../../useAuth.tsx";
import { InputBar } from "./InputBar.tsx";

const media = vi.hoisted(() => ({ mobile: false }));
const RECORD_LABEL_RE = /input\.recordVoice|Voice message/;
const ATTACH_LABEL_RE = /input\.attachFile|Attach file/;
const SEND_LABEL_RE = /input\.send|Send/;
const SAVE_LABEL_RE = /input\.save|Save/;
const ATTACH_PHOTO_RE = /input\.attachPhoto|Photo/;
const ATTACH_VIDEO_RE = /input\.attachVideo|Video/;
const ATTACH_AUDIO_RE = /input\.attachAudio|Audio/;
const ATTACH_LOCATION_RE = /input\.attachLocation|location/i;

vi.mock("@mantine/hooks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@mantine/hooks")>();
	return { ...actual, useMediaQuery: () => media.mobile };
});

function seedAccount() {
	localStorage.setItem(
		"accounts",
		JSON.stringify([
			{
				token: "tok",
				user: { id: "alice:test", nick: "alice" },
				email: "a@example.com",
				expiresAt: "2027-01-01T00:00:00Z",
			},
		]),
	);
	sessionStorage.setItem("activeToken", "tok");
}

function props(overrides: Record<string, unknown> = {}) {
	return {
		text: "",
		onTextChange: vi.fn(),
		onSubmit: vi.fn(),
		editing: false,
		onCancelEdit: vi.fn(),
		...overrides,
	};
}

const CLIPBOARD_NAME_PATTERN = /^clipboard-.*\.png$/;

function submitButton(): HTMLButtonElement {
	const btn = [...document.querySelectorAll("button")].find(
		(b) => b.type === "submit",
	);
	if (!(btn instanceof HTMLButtonElement)) throw new Error("no submit button");

	return btn;
}

function filePicker(): HTMLInputElement {
	const picker = [...document.querySelectorAll("input")].find(
		(el) => el instanceof HTMLInputElement && el.type === "file",
	);
	if (!picker) throw new Error("no file picker");

	return picker;
}

function visibleArea(): HTMLTextAreaElement {
	const areas = [...document.querySelectorAll("textarea")].filter(
		(el): el is HTMLTextAreaElement =>
			el instanceof HTMLTextAreaElement &&
			el.getAttribute("aria-hidden") !== "true",
	);
	if (areas.length !== 1) throw new Error(`areas: ${areas.length}`);

	return areas[0];
}

function renderBar(p: ReturnType<typeof props>) {
	return render(
		<MantineProvider>
			<AuthProvider>
				<InputBar {...(p as React.ComponentProps<typeof InputBar>)} />
			</AuthProvider>
		</MantineProvider>,
	);
}

function pendingFile(): PendingFile {
	return {
		id: "pf1",
		file: new File(["x"], "a.txt", { type: "text/plain" }),
		blobUrl: "blob:pending-1",
		originalName: "a.txt",
		size: 1,
		mimeType: "text/plain",
		fileType: "file",
	};
}

function existingFile(): FileInfo {
	return {
		id: "f1",
		mimeType: "image/png",
		size: 10,
		originalName: "pic.png",
		fileType: "photo",
		url: "https://srv/f/1",
	};
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	seedAccount();
	URL.createObjectURL = vi.fn(() => "blob:mock");
	URL.revokeObjectURL = vi.fn();
	// jsdom has no FontFaceSet; Mantine's autosize Textarea needs it.
	Object.defineProperty(document, "fonts", {
		value: { addEventListener: () => {}, removeEventListener: () => {} },
		configurable: true,
	});
});

describe("input bar", () => {
	it("types and submits the form", () => {
		const onTextChange = vi.fn();
		const onSubmit = vi.fn();
		const onTypingStart = vi.fn();
		const onTypingStop = vi.fn();
		renderBar(
			props({
				text: "hi",
				onTextChange,
				onSubmit,
				onTypingStart,
				onTypingStop,
			}),
		);

		const area = visibleArea();
		fireEvent.change(area, { target: { value: "hi!" } });
		expect(onTextChange).toHaveBeenCalledWith("hi!");
		expect(onTypingStart).toHaveBeenCalledTimes(1);

		fireEvent.submit(area.closest("form") as HTMLFormElement);
		expect(onTypingStop).toHaveBeenCalledTimes(1);
		expect(onSubmit).toHaveBeenCalledTimes(1);
	});

	it("submits on Enter and cancels editing on Escape", () => {
		const onSubmit = vi.fn();
		const onCancelEdit = vi.fn();
		const requestSubmit = vi.fn();
		const spy = vi
			.spyOn(HTMLFormElement.prototype, "requestSubmit")
			.mockImplementation(requestSubmit);
		try {
			renderBar(props({ text: "x", onSubmit, editing: true, onCancelEdit }));

			const area = visibleArea();
			fireEvent.keyDown(area, { key: "Enter", shiftKey: false });
			expect(requestSubmit).toHaveBeenCalledTimes(1);

			fireEvent.keyDown(area, { key: "Enter", shiftKey: true });
			expect(requestSubmit).toHaveBeenCalledTimes(1);

			fireEvent.keyDown(area, { key: "Escape" });
			expect(onCancelEdit).toHaveBeenCalledTimes(1);
		} finally {
			spy.mockRestore();
		}
	});

	it("disables send for empty input", () => {
		const nulls = { pendingLocation: null, existingLocation: null };
		const { rerender } = render(
			<MantineProvider>
				<AuthProvider>
					<InputBar
						{...(props({
							text: "",
							...nulls,
						}) as React.ComponentProps<typeof InputBar>)}
					/>
				</AuthProvider>
			</MantineProvider>,
		);
		// Nothing to send: the send action is hidden and the microphone is
		// the only action on the right.
		expect(
			[...document.querySelectorAll("button")].some(
				(button) => button.type === "submit",
			),
		).toBe(false);
		expect(
			screen.getByRole("button", {
				name: RECORD_LABEL_RE,
			}),
		).toBeTruthy();

		rerender(
			<MantineProvider>
				<AuthProvider>
					<InputBar
						{...props({
							text: "hi",
							...nulls,
						})}
					/>
				</AuthProvider>
			</MantineProvider>,
		);
		expect(submitButton().disabled).toBe(false);
	});

	it("renders send and save as icons", () => {
		const send = renderBar(props({ text: "hello" }));
		expect(submitButton().getAttribute("aria-label")).toMatch(SEND_LABEL_RE);
		expect(submitButton().querySelector("svg")).toBeTruthy();
		send.unmount();

		renderBar(props({ text: "hello", editing: true }));
		expect(submitButton().getAttribute("aria-label")).toMatch(SAVE_LABEL_RE);
		expect(submitButton().querySelector("svg")).toBeTruthy();
	});

	it("enables send with only attachments", () => {
		renderBar(
			props({
				text: "",
				pendingFiles: [pendingFile()],
				pendingLocation: { lat: 1, lng: 2 },
			}),
		);

		expect(submitButton().disabled).toBe(false);
	});

	it("attaches files from the picker", () => {
		const onAttachFiles = vi.fn();
		renderBar(props({ onAttachFiles }));

		const picker = filePicker();
		fireEvent.change(picker, {
			target: { files: [new File(["x"], "a.txt", { type: "text/plain" })] },
		});

		expect(onAttachFiles).toHaveBeenCalledTimes(1);
		const files = onAttachFiles.mock.calls[0][0] as File[];
		expect(files[0].name).toBe("a.txt");
		expect(picker.value).toBe("");
	});

	it("offers file, photo, video, audio and location from the attach menu", async () => {
		const onAttachFiles = vi.fn();
		const onOpenLocationPicker = vi.fn();
		renderBar(props({ onAttachFiles, onOpenLocationPicker }));

		fireEvent.click(
			screen.getByRole("button", {
				name: ATTACH_LABEL_RE,
			}),
		);

		for (const label of [
			ATTACH_PHOTO_RE,
			ATTACH_VIDEO_RE,
			ATTACH_AUDIO_RE,
			ATTACH_LOCATION_RE,
		]) {
			expect(await screen.findByText(label)).toBeTruthy();
		}

		fireEvent.click(await screen.findByText(ATTACH_LOCATION_RE));
		expect(onOpenLocationPicker).toHaveBeenCalledTimes(1);
	});

	it("pastes files from the clipboard", () => {
		const onAttachFiles = vi.fn();
		renderBar(props({ onAttachFiles }));

		const area = visibleArea();
		const pasted = new File(["img"], "p.png", { type: "image/png" });
		fireEvent.paste(area, {
			clipboardData: {
				items: [{ kind: "file", getAsFile: () => pasted }],
			},
		});

		expect(onAttachFiles).toHaveBeenCalledTimes(1);
		const files = onAttachFiles.mock.calls[0][0] as File[];
		expect(files[0].name).toMatch(CLIPBOARD_NAME_PATTERN);
	});

	it("ignores pastes without files", () => {
		const onAttachFiles = vi.fn();
		renderBar(props({ onAttachFiles }));

		const area = visibleArea();
		fireEvent.paste(area, {
			clipboardData: { items: [{ kind: "string", getAsFile: () => null }] },
		});

		expect(onAttachFiles).not.toHaveBeenCalled();
	});

	it("shows and cancels the reply banner", () => {
		const onCancelReply = vi.fn();
		renderBar(
			props({ replyToNick: "bob", replyToText: "hello", onCancelReply }),
		);

		expect(screen.getByText("hello")).toBeTruthy();
		const cancel = document.querySelectorAll("button")[0];
		fireEvent.click(cancel);
		expect(onCancelReply).toHaveBeenCalledTimes(1);
	});

	it("shows the edit banner instead of reply", () => {
		const onCancelEdit = vi.fn();
		renderBar(
			props({
				editing: true,
				replyToNick: "bob",
				replyToText: "hello",
				onCancelEdit,
			}),
		);

		expect(screen.queryByText("hello")).toBeNull();
	});

	it("lists attachments with remove actions", async () => {
		const onRemoveFile = vi.fn();
		const onRemoveExistingFile = vi.fn();
		const onRemovePendingLocation = vi.fn();
		const onRemoveExistingLocation = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(new Blob(["pic"])))),
		);
		renderBar(
			props({
				pendingFiles: [pendingFile()],
				onRemoveFile,
				existingFiles: [existingFile()],
				onRemoveExistingFile,
				pendingLocation: { lat: 1, lng: 2 },
				onRemovePendingLocation,
				existingLocation: { lat: 3, lng: 4 },
				onRemoveExistingLocation,
			}),
		);

		await waitFor(() => {
			expect(document.body.textContent).toContain("a.txt");
		});
		vi.unstubAllGlobals();
	});
});
