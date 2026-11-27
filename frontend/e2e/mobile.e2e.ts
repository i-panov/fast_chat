import {
	type APIRequestContext,
	type Browser,
	expect,
	type Page,
	test,
} from "@playwright/test";

import { completeBackupGate } from "./backup-gate.ts";

// On a phone the list and the open chat must be two panes shown one at a
// time: a fixed 300px sidebar next to the chat leaves no room for messages.
// The test drives the real API and a 390x844 viewport.

interface Account {
	token: string;
	user: { id: string; nick: string };
	email: string;
	expiresAt: string;
}

interface Verified {
	isNew: boolean;
	setupToken?: string;
	user?: Account["user"];
	token?: string;
	expiresAt?: string;
}

async function sendCode(
	request: APIRequestContext,
	email: string,
): Promise<string> {
	const response = await request.post("/api/auth/send-code", {
		data: { email },
	});
	expect(response.ok()).toBeTruthy();
	const body = (await response.json()) as { debugCode?: string };
	if (body.debugCode === undefined) throw new Error("no debug code");

	return body.debugCode;
}

async function register(
	request: APIRequestContext,
	email: string,
	nick: string,
): Promise<Account> {
	const code = await sendCode(request, email);
	const verifiedResponse = await request.post("/api/auth/verify-code", {
		data: { email, code, deviceId: `mobile-${nick}`, deviceName: "Phone" },
	});
	expect(verifiedResponse.ok()).toBeTruthy();
	const verified = (await verifiedResponse.json()) as Verified;

	if (verified.isNew) {
		const registered = await request.post("/api/auth/complete-registration", {
			data: {
				setupToken: verified.setupToken,
				nick,
				deviceId: `mobile-${nick}`,
				deviceName: "Phone",
			},
		});
		expect(registered.ok()).toBeTruthy();
		const body = (await registered.json()) as {
			token: string;
			user: Account["user"];
			expiresAt: string;
		};

		return { ...body, email };
	}

	return {
		token: verified.token as string,
		user: verified.user as Account["user"],
		expiresAt: verified.expiresAt as string,
		email,
	};
}

async function openAs(
	browser: Browser,
	account: Account,
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({
		locale: "en-US",
		viewport: { width: 390, height: 844 },
	});
	await context.addInitScript((stored) => {
		localStorage.setItem("accounts", JSON.stringify([stored]));
		localStorage.setItem("activeToken", stored.token);
		sessionStorage.setItem("activeToken", stored.token);
	}, account);
	const page = await context.newPage();
	await page.goto("/chat");

	return { page, close: () => context.close() };
}

const SEARCH_PLACEHOLDER_RE = /Search users|Поиск пользователей/;
const MIC_RE = /Voice message|Голосовое сообщение/;
const ATTACH_RE = /Attach file|Прикрепить файл/;
const PHOTO_ITEM_RE = /Photo|Фото/;
const VIDEO_ITEM_RE = /Video|Видео/;
const AUDIO_ITEM_RE = /Audio|Аудио/;
const LOCATION_ITEM_RE = /location/i;
const CANCEL_RE = /^(Cancel|Отмена)$/;
const SELECT_RE = /^Select$/;
const DELETE_RE = /^Delete$/;
const DELETE_SELECTED_TITLE_RE = /Delete selected messages/;
const ZERO_SELECTED_RE = /0 selected/;
const TWO_SELECTED_RE = /2 selected/;
const COMPOSER_PLACEHOLDER_RE = /Type a message|Напишите/;
const SEND_BUTTON_RE = /^(Send|Отправить)$/;

test("a phone shows the list and the chat one at a time", async ({
	browser,
	request,
}) => {
	const suffix = Date.now().toString(36);
	const alice = await register(
		request,
		`mobile-a-${suffix}@e2e.local`,
		`ma${suffix}`.slice(0, 20),
	);
	const bob = await register(
		request,
		`mobile-b-${suffix}@e2e.local`,
		`mb${suffix}`.slice(0, 20),
	);

	const chatResponse = await request.post("/api/chats", {
		headers: { Authorization: `Bearer ${alice.token}` },
		data: { type: "private", withUserId: bob.user.id },
	});
	expect(chatResponse.ok()).toBeTruthy();

	const { page, close } = await openAs(browser, alice);

	try {
		// The first login asks before generating the account key. The button
		// must actually create it and the dialog must not return.
		const createKey = page.getByRole("button", { name: "Create new key" });
		await expect(createKey).toBeVisible({ timeout: 15_000 });
		await createKey.click();
		await completeBackupGate(page);

		// The list is the only pane; the 300px sidebar does not sit next to
		// an empty chat pane.
		const row = page.getByText(`${bob.user.nick}`, { exact: false }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		const search = page.getByPlaceholder(SEARCH_PLACEHOLDER_RE);
		await expect(search).toBeVisible();

		await row.click();

		const back = page.getByRole("button", { name: "Back" });
		await expect(back).toBeVisible({ timeout: 10_000 });

		// The composer fits: a wide textarea and an icon send action, not the
		// text button squeezed against the attach icons.
		const input = page.getByPlaceholder(COMPOSER_PLACEHOLDER_RE);
		await expect(input).toBeVisible();
		const box = await input.boundingBox();
		expect(box?.width ?? 0).toBeGreaterThan(170);
		// Empty composer: the microphone is the only right-hand action, the
		// send button is hidden. Typing swaps them.
		const mic = page.getByRole("button", { name: MIC_RE });
		await expect(mic).toBeVisible();
		await expect(
			page.getByRole("button", { name: SEND_BUTTON_RE }),
		).toHaveCount(0);

		await input.fill("Привет");
		await expect(
			page.getByRole("button", { name: SEND_BUTTON_RE }),
		).toBeVisible();
		await expect(mic).toHaveCount(0);
		await input.fill("");
		await expect(mic).toBeVisible();

		// The paperclip owns file/photo/video/audio/location instead of three
		// separate buttons.
		await page.getByRole("button", { name: ATTACH_RE }).click();
		for (const item of [
			PHOTO_ITEM_RE,
			VIDEO_ITEM_RE,
			AUDIO_ITEM_RE,
			LOCATION_ITEM_RE,
		]) {
			await expect(page.getByRole("menuitem", { name: item })).toBeVisible();
		}
		await page.keyboard.press("Escape");

		// Recording replaces the whole composer, including the text input.
		await mic.click();
		const cancel = page.getByRole("button", { name: CANCEL_RE });
		await expect(cancel).toBeVisible({ timeout: 15_000 });
		await expect(input).toBeHidden();
		await cancel.click();
		await expect(input).toBeVisible({ timeout: 10_000 });

		// The list is gone, the chat fills the screen.
		await expect(search).toHaveCount(0);

		await back.click();
		await expect(search).toBeVisible({ timeout: 10_000 });
		await expect(back).toHaveCount(0);
	} finally {
		await close();
	}
});

test("selects several messages and deletes them together", async ({
	browser,
	request,
}) => {
	const suffix = Date.now().toString(36);
	const alice = await register(
		request,
		`bulk-a-${suffix}@e2e.local`,
		`ba${suffix}`.slice(0, 20),
	);
	const bob = await register(
		request,
		`bulk-b-${suffix}@e2e.local`,
		`bb${suffix}`.slice(0, 20),
	);

	const chatResponse = await request.post("/api/chats", {
		headers: { Authorization: `Bearer ${alice.token}` },
		data: { type: "private", withUserId: bob.user.id },
	});
	expect(chatResponse.ok()).toBeTruthy();
	const { chat } = (await chatResponse.json()) as { chat: { id: string } };

	for (const [index, text] of ["Bulk one", "Bulk two"].entries()) {
		const sent = await request.post(`/api/chats/${chat.id}/messages`, {
			headers: { Authorization: `Bearer ${alice.token}` },
			data: { id: `bulk-${suffix}-${index}`, text },
		});
		expect(sent.ok()).toBeTruthy();
	}

	const { page, close } = await openAs(browser, alice);

	try {
		const createKey = page.getByRole("button", { name: "Create new key" });
		await expect(createKey).toBeVisible({ timeout: 15_000 });
		await createKey.click();
		await completeBackupGate(page);

		const row = page.getByText(`${bob.user.nick}`, { exact: false }).first();
		await row.click();
		await expect(page.getByText("Bulk one")).toBeVisible({ timeout: 15_000 });

		await page.getByRole("button", { name: SELECT_RE }).click();
		await expect(page.getByText(ZERO_SELECTED_RE)).toBeVisible();

		await page.getByText("Bulk one").click();
		await page.getByText("Bulk two").click();
		await expect(page.getByText(TWO_SELECTED_RE)).toBeVisible();

		await page.getByRole("button", { name: DELETE_RE }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText(DELETE_SELECTED_TITLE_RE)).toBeVisible();
		await dialog.getByRole("button", { name: DELETE_RE }).click();

		await expect(page.getByText("No messages yet")).toBeVisible({
			timeout: 15_000,
		});
		await expect(page.getByRole("button", { name: SELECT_RE })).toBeVisible();

		// The local list is optimistic: prove the outbox actually removed the
		// messages on the server as well.
		await expect
			.poll(
				async () => {
					const response = await request.get(`/api/chats/${chat.id}/messages`, {
						headers: { Authorization: `Bearer ${alice.token}` },
					});
					const body = (await response.json()) as {
						messages: unknown[];
					};

					return body.messages.length;
				},
				{ timeout: 15_000 },
			)
			.toBe(0);
	} finally {
		await close();
	}
});
