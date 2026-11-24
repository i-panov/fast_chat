import { expect, test } from "@playwright/test";

test("web locks serialize and background sync is available", async ({
	page,
}) => {
	await page.goto("/");
	const result = await page.evaluate(async () => {
		const order: string[] = [];
		const first = navigator.locks.request("fastchat-e2e-lock", async () => {
			order.push("first");
			await new Promise((resolve) => setTimeout(resolve, 50));
		});
		const second = navigator.locks.request("fastchat-e2e-lock", () => {
			order.push("second");
		});
		await Promise.all([first, second]);
		return { order, hasSync: "sync" in ServiceWorkerRegistration.prototype };
	});
	expect(result.order).toEqual(["first", "second"]);
	expect(result.hasSync).toBe(true);
});
