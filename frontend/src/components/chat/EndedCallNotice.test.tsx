import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EndedCallNotice } from "./EndedCallNotice.tsx";

function renderNotice(
	props: Partial<React.ComponentProps<typeof EndedCallNotice>> = {},
) {
	return render(
		<MantineProvider>
			<EndedCallNotice
				reason="timeout"
				callRole="caller"
				peerNick="bob"
				onDismiss={vi.fn()}
				{...props}
			/>
		</MantineProvider>,
	);
}

describe("EndedCallNotice", () => {
	it("reports that the callee did not answer", () => {
		renderNotice({ reason: "timeout", callRole: "caller" });

		expect(screen.getByText("call.notAnswered")).toBeTruthy();
	});

	it("reports a missed call to the callee", () => {
		renderNotice({ reason: "timeout", callRole: "callee" });

		expect(screen.getByText("call.missed")).toBeTruthy();
	});

	it("reports that the peer disconnected", () => {
		renderNotice({ reason: "peer-left", callRole: "callee" });

		expect(screen.getByText("call.peerLeft")).toBeTruthy();
	});

	it("says nothing to the caller when the peer disconnected", () => {
		renderNotice({ reason: "peer-left", callRole: "caller" });

		expect(screen.queryByText("call.peerLeft")).toBeNull();
	});

	it("says nothing about a call both sides ended", () => {
		renderNotice({ reason: "hangup", callRole: "callee" });

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("dismisses itself for a normal ending", () => {
		const onDismiss = vi.fn();
		renderNotice({ reason: "hangup", callRole: "callee", onDismiss });

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});

	it("closes the notice", () => {
		const onDismiss = vi.fn();
		renderNotice({ onDismiss });

		fireEvent.click(screen.getByRole("button", { name: "call.close" }));

		expect(onDismiss).toHaveBeenCalledTimes(1);
	});
});
