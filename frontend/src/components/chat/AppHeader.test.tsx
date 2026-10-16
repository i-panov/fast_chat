import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader.tsx";

const syncStateHolder = vi.hoisted(() => ({ current: "idle" }));

vi.mock("../../hooks/useSyncStatus.ts", () => ({
	useSyncStatus: () => syncStateHolder.current,
}));

function renderHeader(onSwitcherToggle: () => void = () => {}) {
	return render(
		<MantineProvider>
			<AppHeader onSwitcherToggle={onSwitcherToggle} />
		</MantineProvider>,
	);
}

function dotWith(container: HTMLElement, color: string) {
	return [...container.querySelectorAll("div")].find((el) =>
		el.getAttribute("style")?.includes(color),
	);
}

function setOnLine(value: boolean) {
	Object.defineProperty(window.navigator, "onLine", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	setOnLine(true);
	syncStateHolder.current = "idle";
});

describe("AppHeader", () => {
	it("toggles the account switcher", () => {
		const onSwitcherToggle = vi.fn();
		renderHeader(onSwitcherToggle);

		fireEvent.click(screen.getByRole("button", { name: "accounts.title" }));

		expect(onSwitcherToggle).toHaveBeenCalledTimes(1);
	});

	it("shows the syncing spinner", () => {
		syncStateHolder.current = "syncing";
		renderHeader();

		expect(screen.getByLabelText("sync.syncing")).toBeTruthy();
	});

	it("shows the offline indicator", () => {
		setOnLine(false);
		const { container } = renderHeader();
		act(() => {
			window.dispatchEvent(new Event("offline"));
		});

		expect(dotWith(container, "red-6")).toBeTruthy();
	});

	it("shows the error indicator", () => {
		syncStateHolder.current = "error";
		const { container } = renderHeader();

		expect(dotWith(container, "red-6")).toBeTruthy();
	});

	it("shows the online indicator", () => {
		const { container } = renderHeader();

		expect(dotWith(container, "green-6")).toBeTruthy();
	});
});
