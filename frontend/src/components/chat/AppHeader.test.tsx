import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppHeader } from "./AppHeader.tsx";

const syncStateHolder = vi.hoisted(() => ({ current: "idle" }));
const lockStateHolder = vi.hoisted(() => ({ enabled: false, locked: false }));
const requestLocalLock = vi.hoisted(() => vi.fn());

vi.mock("../../hooks/useSyncStatus.ts", () => ({
	useSyncStatus: () => syncStateHolder.current,
}));

vi.mock("../../hooks/useLocalLockState.ts", () => ({
	useLocalLockState: () => lockStateHolder,
}));

vi.mock("../../e2ee/localLock.ts", () => ({ requestLocalLock }));

function renderHeader(onSwitcherToggle: () => void = () => {}) {
	return render(
		<MantineProvider>
			<AppHeader accountKey="alice:test" onSwitcherToggle={onSwitcherToggle} />
		</MantineProvider>,
	);
}

function dotWith(container: HTMLElement, color: string) {
	return [...container.querySelectorAll("div,output,span")].find((el) =>
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
	lockStateHolder.enabled = false;
	lockStateHolder.locked = false;
	requestLocalLock.mockClear();
});

describe("AppHeader", () => {
	it("locks the account on demand when a local lock is configured", () => {
		lockStateHolder.enabled = true;
		renderHeader();

		fireEvent.click(screen.getByRole("button", { name: "localLock.lockNow" }));

		expect(requestLocalLock).toHaveBeenCalledTimes(1);
	});

	it("hides the lock button without a local lock", () => {
		renderHeader();

		expect(screen.queryByRole("button", { name: "localLock.lockNow" })).toBe(
			null,
		);
	});

	it("hides the lock button while the keys are already locked", () => {
		lockStateHolder.enabled = true;
		lockStateHolder.locked = true;
		renderHeader();

		expect(screen.queryByRole("button", { name: "localLock.lockNow" })).toBe(
			null,
		);
	});

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
