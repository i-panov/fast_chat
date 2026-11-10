import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

// The backend is deliberately multi-device: logging in on a second device
// must not invalidate the first session, and both devices must see each
// other in the sessions list. This is proven with two real browser contexts
// and the real API.

const CHAT_URL_RE = /\/chat/;

interface Account {
	token: string;
	user: { id: string; nick: string; online?: boolean };
	email: string;
	expiresAt: string;
	sessionId: string;
	deviceId: string;
}

interface Verified {
	isNew: boolean;
	setupToken?: string;
	user?: Account["user"];
	token?: string;
	expiresAt?: string;
	sessionId?: string;
	deviceId?: string;
}

interface Registered {
	token: string;
	expiresAt: string;
	user: Account["user"];
	sessionId?: string;
	deviceId?: string;
}

async function sendCode(
	request: APIRequestContext,
	email: string,
): Promise<string> {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		const response = await request.post("/api/auth/send-code", {
			data: { email },
		});
		if (response.ok()) {
			const body = (await response.json()) as { debugCode?: string };
			if (body.debugCode !== undefined) return body.debugCode;
		}
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	throw new Error("send-code did not return a debug code");
}

async function login(
	request: APIRequestContext,
	email: string,
	nick: string,
	deviceId: string,
	deviceName: string,
): Promise<Account> {
	const code = await sendCode(request, email);
	const response = await request.post("/api/auth/verify-code", {
		data: { email, code, deviceId, deviceName },
	});
	expect(response.ok()).toBeTruthy();
	const verified = (await response.json()) as Verified;

	if (verified.isNew) {
		expect(verified.setupToken).toBeDefined();
		const registered = await request.post("/api/auth/complete-registration", {
			data: {
				setupToken: verified.setupToken,
				nick,
				deviceId,
				deviceName,
			},
		});
		expect(registered.ok()).toBeTruthy();
		const body = (await registered.json()) as Registered;
		return {
			...body,
			user: body.user,
			email,
			sessionId: body.sessionId ?? "",
			deviceId: body.deviceId ?? deviceId,
		};
	}

	expect(verified.token).toBeDefined();
	expect(verified.user).toBeDefined();
	return {
		user: verified.user as Account["user"],
		token: verified.token as string,
		expiresAt: verified.expiresAt as string,
		email,
		sessionId: verified.sessionId ?? "",
		deviceId: verified.deviceId ?? deviceId,
	};
}

async function openChat(
	browser: Browser,
	account: Account,
): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ locale: "en-US" });
	await context.addInitScript(
		({ stored, token }) => {
			localStorage.setItem("accounts", JSON.stringify([stored]));
			localStorage.setItem("activeToken", token);
			sessionStorage.setItem("activeToken", token);
		},
		{ stored: account, token: account.token },
	);
	const page = await context.newPage();
	await page.goto("/chat");
	await expect(page).toHaveURL(CHAT_URL_RE);
	// With two sessions and no key backup the guard deliberately opens. The
	// test dismisses it: the guard itself is covered by the unit tests.
	const close = page.getByRole("button", { name: "Close" });
	await expect(close)
		.toBeVisible({ timeout: 10_000 })
		.catch(() => undefined);
	if (await close.isVisible().catch(() => false)) {
		await close.click();
	}
	await expect(page.getByRole("button", { name: "Accounts" })).toBeVisible();
	return { context, page };
}

test("two devices keep independent sessions", async ({ browser, request }) => {
	const suffix = `${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
	const email = `multi-${suffix}@e2e.local`;
	const nick = `m${suffix}`.slice(0, 20);

	const first = await login(request, email, nick, "e2e-desktop", "Desktop A");
	const second = await login(request, email, nick, "e2e-phone", "Phone B");

	expect(first.token).not.toBe(second.token);

	const sessions = await request.get("/api/sessions", {
		headers: { Authorization: `Bearer ${first.token}` },
	});
	expect(sessions.ok()).toBeTruthy();
	const sessionBody = (await sessions.json()) as {
		currentSessionId: string;
		sessions: Array<{ deviceName: string; current: boolean }>;
	};
	expect(sessionBody.sessions).toHaveLength(2);
	expect(sessionBody.sessions.map((s) => s.deviceName).sort()).toEqual([
		"Desktop A",
		"Phone B",
	]);

	// The first token must still work after the second login.
	const chats = await request.get("/api/chats", {
		headers: { Authorization: `Bearer ${first.token}` },
	});
	expect(chats.ok()).toBeTruthy();

	const desktop = await openChat(browser, first);
	const phone = await openChat(browser, second);

	await desktop.page.getByRole("button", { name: "Accounts" }).click();
	await desktop.page.getByRole("button", { name: "Devices" }).click();
	await expect(desktop.page.getByText("Desktop A")).toBeVisible();
	await expect(desktop.page.getByText("Phone B")).toBeVisible();

	await phone.page.getByRole("button", { name: "Accounts" }).click();
	await phone.page.getByRole("button", { name: "Devices" }).click();
	await expect(phone.page.getByText("Desktop A")).toBeVisible();
	await expect(phone.page.getByText("Phone B")).toBeVisible();

	await desktop.context.close();
	await phone.context.close();
});
