import { describe, expect, it, vi } from "vitest";
import { emitNotification, onNotification } from "./notify.ts";

describe("notifications", () => {
	it("delivers the message with the default error type", () => {
		const seen: Array<{ message: string; type: string }> = [];
		const off = onNotification((n) => seen.push(n));

		emitNotification("boom");

		expect(seen).toEqual([{ message: "boom", type: "error" }]);
		off();
	});

	it("delivers info notifications", () => {
		const seen: Array<{ message: string; type: string }> = [];
		const off = onNotification((n) => seen.push(n));

		emitNotification("hi", "info");

		expect(seen).toEqual([{ message: "hi", type: "info" }]);
		off();
	});

	it("stops delivering after unsubscribe", () => {
		const fn = vi.fn();
		const off = onNotification(fn);
		off();

		emitNotification("late");

		expect(fn).not.toHaveBeenCalled();
	});
});
