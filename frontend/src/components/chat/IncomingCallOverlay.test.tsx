import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IncomingCallOverlay } from "./IncomingCallOverlay.tsx";

function renderOverlay(
	props: Partial<React.ComponentProps<typeof IncomingCallOverlay>> = {},
) {
	return render(
		<MantineProvider>
			<IncomingCallOverlay
				open={true}
				peerNick="bob"
				onAccept={vi.fn()}
				onReject={vi.fn()}
				{...props}
			/>
		</MantineProvider>,
	);
}

describe("IncomingCallOverlay", () => {
	it("takes the call", () => {
		const onAccept = vi.fn();
		renderOverlay({ onAccept });

		fireEvent.click(screen.getByRole("button", { name: "call.accept" }));

		expect(onAccept).toHaveBeenCalledTimes(1);
	});

	it("declines the call", () => {
		const onReject = vi.fn();
		renderOverlay({ onReject });

		fireEvent.click(screen.getByRole("button", { name: "call.reject" }));

		expect(onReject).toHaveBeenCalledTimes(1);
	});

	it("shows nothing when there is no call", () => {
		renderOverlay({ open: false });

		expect(screen.queryByRole("button")).toBeNull();
	});
});
