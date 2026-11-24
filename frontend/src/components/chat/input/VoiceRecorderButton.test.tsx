import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onNotification } from "../../../utils/notify.ts";
import { VoiceRecorderButton } from "./VoiceRecorderButton.tsx";

const RECORD_LABEL_RE = /input\.recordVoice|Voice message/;
const REQUESTING_LABEL_RE =
	/input\.requestingMic|Waiting for microphone access/;

// biome-ignore lint/complexity/noStaticOnlyClass: the tests only need the static capability check.
class FakeMediaRecorder {
	static isTypeSupported(): boolean {
		return true;
	}
}

function setMediaDevices(getUserMedia: () => Promise<MediaStream>): void {
	Object.defineProperty(navigator, "mediaDevices", {
		value: { getUserMedia },
		configurable: true,
	});
}

function renderButton() {
	return render(
		<MantineProvider>
			<VoiceRecorderButton onAttachFiles={vi.fn()} />
		</MantineProvider>,
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

function setSecureContext(value: boolean): void {
	Object.defineProperty(window, "isSecureContext", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "mediaDevices");
	Reflect.deleteProperty(window, "isSecureContext");
});

describe("VoiceRecorderButton", () => {
	it("reports an unsupported browser instead of failing silently", () => {
		vi.stubGlobal("MediaRecorder", undefined);
		const notifications = vi.fn();
		const off = onNotification(notifications);
		renderButton();

		fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordUnsupported",
			type: "error",
		});
		off();
	});

	it("shows a pending state and times out a dismissed permission prompt", async () => {
		vi.useFakeTimers();
		setMediaDevices(() => new Promise<MediaStream>(() => undefined));
		const notifications = vi.fn();
		const off = onNotification(notifications);
		renderButton();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));
			await Promise.resolve();
		});

		const pending = screen.getByRole("button", {
			name: REQUESTING_LABEL_RE,
		});
		expect(pending).toBeDisabled();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(15_000);
		});

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordTimeout",
			type: "error",
		});
		expect(screen.getByRole("button", { name: RECORD_LABEL_RE })).toBeEnabled();
		off();
	});

	it("explains a denied microphone permission", async () => {
		setMediaDevices(() =>
			Promise.reject(new DOMException("denied", "NotAllowedError")),
		);
		const notifications = vi.fn();
		const off = onNotification(notifications);
		renderButton();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));
			await Promise.resolve();
		});

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordDenied",
			type: "error",
		});
		off();
	});

	it("reports a missing microphone", async () => {
		setMediaDevices(() =>
			Promise.reject(new DOMException("missing", "NotFoundError")),
		);
		const notifications = vi.fn();
		const off = onNotification(notifications);
		renderButton();

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));
			await Promise.resolve();
		});

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordNoDevice",
			type: "error",
		});
		off();
	});

	it("refuses to start in an insecure context", () => {
		setSecureContext(false);
		const getUserMedia = vi.fn();
		setMediaDevices(getUserMedia);
		const notifications = vi.fn();
		const off = onNotification(notifications);
		renderButton();

		fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordInsecure",
			type: "error",
		});
		expect(getUserMedia).not.toHaveBeenCalled();
		off();
		vi.restoreAllMocks();
	});
});
