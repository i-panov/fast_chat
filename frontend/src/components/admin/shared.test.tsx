import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, type ConfirmState } from "./shared.tsx";

const t = ((key: string) => key) as unknown as TFunction;

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});

	return { promise, resolve };
}

function confirmState(onConfirm: () => Promise<void>): ConfirmState {
	return { title: "Delete chat", body: "Sure?", onConfirm };
}

describe("admin ConfirmDialog", () => {
	it("stays open and ignores Escape while the action runs", async () => {
		const pending = deferred();
		const onClose = vi.fn();
		render(
			<MantineProvider>
				<ConfirmDialog
					state={confirmState(() => pending.promise)}
					onClose={onClose}
					t={t}
				/>
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "admin.confirm" }));

		fireEvent.keyDown(document, { key: "Escape" });
		expect(onClose).not.toHaveBeenCalled();

		pending.resolve();
		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	it("does not close a newer action with an older result", async () => {
		const first = deferred();
		const second = deferred();
		const onClose = vi.fn();
		const { rerender } = render(
			<MantineProvider>
				<ConfirmDialog
					state={confirmState(() => first.promise)}
					onClose={onClose}
					t={t}
				/>
			</MantineProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "admin.confirm" }));
		rerender(
			<MantineProvider>
				<ConfirmDialog
					state={confirmState(() => second.promise)}
					onClose={onClose}
					t={t}
				/>
			</MantineProvider>,
		);

		first.resolve();
		await waitFor(() => {
			expect(onClose).not.toHaveBeenCalled();
		});

		fireEvent.click(screen.getByRole("button", { name: "admin.confirm" }));
		second.resolve();
		await waitFor(() => {
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});
});
