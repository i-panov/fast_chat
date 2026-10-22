import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CallButton } from "./CallButton.tsx";

function renderButton(
	props: Partial<React.ComponentProps<typeof CallButton>> = {},
) {
	return render(
		<MantineProvider>
			<CallButton
				peer={{ id: "bob:localhost:8080", nick: "bob" }}
				localUserId="alice:localhost:8080"
				disabled={false}
				onCall={vi.fn()}
				{...props}
			/>
		</MantineProvider>,
	);
}

describe("CallButton", () => {
	it("calls a local peer", () => {
		const onCall = vi.fn();
		renderButton({ onCall });

		fireEvent.click(screen.getByRole("button", { name: "call.start" }));

		expect(onCall).toHaveBeenCalledTimes(1);
	});

	it("is hidden without a peer", () => {
		renderButton({ peer: undefined });

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("is hidden for a peer on another server", () => {
		renderButton({ peer: { id: "bob:remote.test", nick: "bob" } });

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("is hidden for the own chat", () => {
		renderButton({ peer: { id: "alice:localhost:8080", nick: "alice" } });

		expect(screen.queryByRole("button")).toBeNull();
	});

	it("does nothing while it is disabled", () => {
		const onCall = vi.fn();
		renderButton({ onCall, disabled: true });

		fireEvent.click(screen.getByRole("button", { name: "call.start" }));

		expect(onCall).not.toHaveBeenCalled();
	});
});
