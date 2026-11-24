import {
	type APIRequestContext,
	type Browser,
	expect,
	type Page,
	test,
} from "@playwright/test";

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
		await expect(page.getByRole("dialog")).toHaveCount(0, {
			timeout: 20_000,
		});

		// The list is the only pane; the 300px sidebar does not sit next to
		// an empty chat pane.
		const row = page.getByText(`@${bob.user.nick}`, { exact: false }).first();
		await expect(row).toBeVisible({ timeout: 15_000 });
		const search = page.getByPlaceholder(SEARCH_PLACEHOLDER_RE);
		await expect(search).toBeVisible();

		await row.click();

		const back = page.getByRole("button", { name: "Back" });
		await expect(back).toBeVisible({ timeout: 10_000 });
		// The list is gone, the chat fills the screen.
		await expect(search).toHaveCount(0);

		await back.click();
		await expect(search).toBeVisible({ timeout: 10_000 });
		await expect(back).toHaveCount(0);
	} finally {
		await close();
	}
});
