// biome-ignore-all lint/security/noSecrets: the file has no secrets; DOM selectors are false positives.
import { expect, type Page } from "@playwright/test";

const SAVE_BUTTON = /Enable backup|Change password/;
const CLOSE_BUTTON = /^Close$/;

// The mandatory backup gate appears right after the first key is created.
// Scope to visible inputs: a closed Mantine modal elsewhere in the DOM keeps a
// second copy of the same labelled fields, so role+name locators are ambiguous.
// The first two password inputs are the recovery pair; the PIN fields follow.
export async function completeBackupGate(page: Page): Promise<void> {
	const passwords = page.locator('input[type="password"]:visible');
	const save = page
		.locator("button:visible")
		.filter({ hasText: SAVE_BUTTON })
		.first();
	const close = page
		.locator("button:visible")
		.filter({ hasText: CLOSE_BUTTON })
		.first();

	await expect(passwords.nth(1)).toBeVisible({ timeout: 20_000 });
	await expect(async () => {
		await passwords.nth(0).fill("backup-pass");
		await passwords.nth(1).fill("backup-pass");
		await expect(save).toBeEnabled({ timeout: 1000 });
	}).toPass({ timeout: 15_000 });

	await save.click();
	await close.click();
	await expect(page.locator('[role="dialog"]:visible')).toHaveCount(0, {
		timeout: 20_000,
	});
}
