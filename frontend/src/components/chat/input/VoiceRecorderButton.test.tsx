import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { onNotification } from "../../../utils/notify.ts";
import { VoiceRecorderButton } from "./VoiceRecorderButton.tsx";

const RECORD_LABEL_RE = /input\.recordVoice|Voice message/;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("VoiceRecorderButton", () => {
	it("reports an unsupported browser instead of failing silently", () => {
		const notifications = vi.fn();
		const off = onNotification(notifications);
		render(
			<MantineProvider>
				<VoiceRecorderButton onAttachFiles={vi.fn()} />
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: RECORD_LABEL_RE }));

		expect(notifications).toHaveBeenCalledWith({
			message: "input.recordUnsupported",
			type: "error",
		});
		off();
	});
});
