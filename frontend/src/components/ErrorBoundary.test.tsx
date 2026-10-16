import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

function renderBoundary(ui: ReactElement) {
	return render(<MantineProvider>{ui}</MantineProvider>);
}

function Boom({ message }: { message: string }): ReactElement {
	throw new Error(message);
}

describe("ErrorBoundary", () => {
	it("renders children when healthy", () => {
		renderBoundary(
			<ErrorBoundary>
				<span>fine</span>
			</ErrorBoundary>,
		);

		expect(screen.getByText("fine")).toBeTruthy();
	});

	it("shows the fallback page and recovers on reset", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		let fail = true;
		function Flaky() {
			if (fail) throw new Error("kaboom");
			return <span>recovered</span>;
		}

		renderBoundary(
			<ErrorBoundary>
				<Flaky />
			</ErrorBoundary>,
		);

		expect(screen.getByText("kaboom")).toBeTruthy();

		fail = false;
		fireEvent.click(screen.getByRole("button"));

		expect(screen.getByText("recovered")).toBeTruthy();
		vi.restoreAllMocks();
	});

	it("renders a custom fallback", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		renderBoundary(
			<ErrorBoundary fallback={<span>custom</span>}>
				<Boom message="" />
			</ErrorBoundary>,
		);

		expect(screen.getByText("custom")).toBeTruthy();
		vi.restoreAllMocks();
	});
});
