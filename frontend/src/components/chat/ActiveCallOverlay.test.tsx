import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActiveCallOverlay } from "./ActiveCallOverlay.tsx";

function renderOverlay(
	props: Partial<React.ComponentProps<typeof ActiveCallOverlay>> = {},
) {
	return render(
		<MantineProvider>
			<ActiveCallOverlay
				open={true}
				peerNick="bob"
				localStream={undefined}
				remoteStream={undefined}
				muted={false}
				cameraOn={true}
				onToggleMute={vi.fn()}
				onToggleCamera={vi.fn()}
				onHangup={vi.fn()}
				{...props}
			/>
		</MantineProvider>,
	);
}

describe("ActiveCallOverlay", () => {
	it("ends the call", () => {
		const onHangup = vi.fn();
		renderOverlay({ onHangup });

		fireEvent.click(screen.getByRole("button", { name: "call.hangup" }));

		expect(onHangup).toHaveBeenCalledTimes(1);
	});

	it("switches the microphone", () => {
		const onToggleMute = vi.fn();
		renderOverlay({ onToggleMute });

		fireEvent.click(screen.getByRole("button", { name: "call.mute" }));

		expect(onToggleMute).toHaveBeenCalledTimes(1);
	});

	it("switches the camera", () => {
		const onToggleCamera = vi.fn();
		renderOverlay({ onToggleCamera });

		fireEvent.click(screen.getByRole("button", { name: "call.cameraOff" }));

		expect(onToggleCamera).toHaveBeenCalledTimes(1);
	});

	it("shows the own preview only with the camera on", () => {
		const { rerender } = renderOverlay({ cameraOn: true });

		expect(screen.getByLabelText("call.localVideo")).toBeTruthy();

		rerender(
			<MantineProvider>
				<ActiveCallOverlay
					open={true}
					peerNick="bob"
					localStream={undefined}
					remoteStream={undefined}
					muted={false}
					cameraOn={false}
					onToggleMute={vi.fn()}
					onToggleCamera={vi.fn()}
					onHangup={vi.fn()}
				/>
			</MantineProvider>,
		);

		expect(screen.queryByLabelText("call.localVideo")).toBeNull();
	});

	it("shows nothing when there is no call", () => {
		renderOverlay({ open: false });

		expect(screen.queryByRole("button")).toBeNull();
	});
});
