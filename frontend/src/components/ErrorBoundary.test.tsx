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

const BOUNDARY_TITLE_RE = /Something went wrong|Что-то пошло не так/;
const BACK_LINK_RE = /Back to chats|Вернуться к чатам/;

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

		// The raw exception text may contain message fragments or user ids:
		// it must not be rendered.
		expect(screen.queryByText("kaboom")).toBeNull();
		expect(screen.getByText(BOUNDARY_TITLE_RE)).toBeTruthy();

		fail = false;
		fireEvent.click(screen.getByRole("button"));

		expect(screen.getByText("recovered")).toBeTruthy();
		vi.restoreAllMocks();
	});

	it("reports a diagnostic without the exception message", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const onError = vi.fn();

		renderBoundary(
			<ErrorBoundary onError={onError}>
				<Boom message="secret chat name" />
			</ErrorBoundary>,
		);

		expect(onError).toHaveBeenCalledTimes(1);
		const diagnostic = onError.mock.calls[0][0] as {
			name: string;
			componentStack: string;
		};
		expect(diagnostic.name).toBe("Error");
		expect(diagnostic.componentStack).toBeTruthy();
		expect(JSON.stringify(diagnostic)).not.toContain("secret chat name");
		vi.restoreAllMocks();
	});

	it("offers a way back to the chats", () => {
		vi.spyOn(console, "error").mockImplementation(() => {});

		renderBoundary(
			<ErrorBoundary>
				<Boom message="" />
			</ErrorBoundary>,
		);

		const back = screen.getByRole("link", {
			name: BACK_LINK_RE,
		});
		expect(back.getAttribute("href")).toBe("/chat");
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
