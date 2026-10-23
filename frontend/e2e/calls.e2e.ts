import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

// The call is proven with two real browsers: the unit tests replace the peer
// connection with a stub, which says nothing about the media actually
// flowing.
//
// The users and their chat are prepared through the API: starting a chat
// through the interface needs the end-to-end keys of both users, and keys
// have nothing to do with a call.

// The interface reads the account from the local storage on start, and the
// route guard of the chat page only looks at the session storage.
const ACCOUNT_KEY = "accounts";
const TOKEN_KEY = "activeToken";

// The accounts are fixed: the registration endpoints of the server are rate
// limited, and a fresh pair on every run would spend the limit in a few runs.
const CALLER_EMAIL = "caller@e2e.local";
const CALLEE_EMAIL = "callee@e2e.local";

// A run started right after another one waits for the rate limit window of
// the moment the code is sent.
const RATE_LIMIT_WAIT = 20_000;
const SEND_CODE_ATTEMPTS = 3;

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

interface Session {
	account: Account;
	context: BrowserContext;
	page: Page;
}

interface Pair {
	caller: Session;
	callee: Session;
}

interface CurrentCallAnswer {
	state: string;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

// sendCode asks for the verification code. The endpoint is rate limited: a
// run repeated right after another one waits for the window instead of
// failing.
async function sendCode(
	request: APIRequestContext,
	email: string,
): Promise<string> {
	for (let attempt = 1; attempt <= SEND_CODE_ATTEMPTS; attempt += 1) {
		const sent = await request.post("/api/auth/send-code", {
			data: { email },
		});

		if (sent.status() !== 429) {
			const { debugCode } = (await sent.json()) as { debugCode?: string };

			if (debugCode === undefined) {
				throw new Error(
					`send-code answered ${sent.status()}: ${await sent.text()}`,
				);
			}

			return debugCode;
		}

		await sleep(RATE_LIMIT_WAIT);
	}

	throw new Error("send-code is rate limited: run the test a minute later");
}

// register creates the user and answers the account the interface keeps. The
// development configuration returns the verification code, so the test does
// not need the mailbox.
async function register(
	request: APIRequestContext,
	email: string,
	nick: string,
): Promise<Account> {
	const verified = await request.post("/api/auth/verify-code", {
		data: { code: await sendCode(request, email), email },
	});
	const answer = (await verified.json()) as Verified;

	// The user of an earlier run comes back with a session of its own.
	if (!answer.isNew) {
		const { expiresAt, token, user } = answer;

		if (user === undefined || token === undefined || expiresAt === undefined) {
			throw new Error("verify-code answered an incomplete account");
		}

		return { email, expiresAt, token, user };
	}

	const completed = await request.post("/api/auth/complete-registration", {
		data: { nick, setupToken: answer.setupToken },
	});
	if (!completed.ok()) {
		throw new Error(
			`complete-registration answered ${completed.status()}: ${await completed.text()}`,
		);
	}

	const created = (await completed.json()) as Omit<Account, "email">;

	return { ...created, email };
}

// createChat opens the private chat the users call from: the call button
// lives in the header of an existing chat. The server answers the chat that
// the pair already has.
async function createChat(
	request: APIRequestContext,
	caller: Account,
	peer: Account,
): Promise<void> {
	const created = await request.post("/api/chats", {
		headers: { Authorization: `Bearer ${caller.token}` },
		data: { type: "private", withUserId: peer.user.id },
	});

	if (!created.ok()) {
		throw new Error(
			`create chat answered ${created.status()}: ${await created.text()}`,
		);
	}
}

// open signs the page in and opens the private chat with the peer: the call
// button lives in the header of an existing chat.
async function open(
	browser: Browser,
	account: Account,
	peer: Account,
): Promise<Session> {
	const context = await browser.newContext({ locale: "en-US" });

	// The script runs before the page: the storage is filled before the
	// interface reads it. The first document of the page has no origin of its
	// own, and the storage of it is not reachable.
	await context.addInitScript(
		({ accountsKey, tokenKey, stored }) => {
			try {
				localStorage.setItem(accountsKey, JSON.stringify([stored]));
				localStorage.setItem(tokenKey, stored.token);
				sessionStorage.setItem(tokenKey, stored.token);
			} catch {
				// The blank document of the browser is not the page itself.
			}
		},
		{ accountsKey: ACCOUNT_KEY, stored: account, tokenKey: TOKEN_KEY },
	);

	const page = await context.newPage();

	// The call arrives through the stream of the server, and the stream is
	// answered only after the connection is registered: a call started
	// before the answer would not reach the page.
	const stream = page.waitForResponse(
		(response) =>
			response.url().includes("/api/events") && response.status() === 200,
	);

	await page.goto("/chat");
	await stream;
	await page.getByRole("button", { name: `@${peer.user.nick}` }).click();

	return { account, context, page };
}

// waitForNoCall waits for the end of the call of the previous test: the
// server forgets a call later than the pages of the test do.
async function waitForNoCall(
	request: APIRequestContext,
	account: Account,
): Promise<void> {
	await expect
		.poll(async () => {
			const answered = await request.get("/api/calls/current", {
				headers: { Authorization: `Bearer ${account.token}` },
			});

			if (answered.status() === 404) {
				return true;
			}

			const { state } = (await answered.json()) as CurrentCallAnswer;

			return state === "ended";
		})
		.toBe(true);
}

// callAndAccept has the caller press the call button and the callee answer.
async function callAndAccept(pair: Pair): Promise<void> {
	const { callee, caller } = pair;
	const nick = caller.account.user.nick;

	await caller.page.getByRole("button", { name: "Call", exact: true }).click();

	await expect(
		callee.page.getByText(`Incoming call from ${nick}`),
	).toBeVisible();
	await callee.page.getByRole("button", { name: "Accept" }).click();
}

// expectMedia waits for the frames of the other side: the width of the video
// stays zero until the media flows.
async function expectMedia(page: Page): Promise<void> {
	const video = page.getByLabel("Video of the peer");

	await expect(video).toBeVisible();
	await expect
		.poll(async () =>
			Number(
				await video.evaluate(
					(element) => (element as HTMLVideoElement).videoWidth,
				),
			),
		)
		.toBeGreaterThan(0);
}

// hangup ends the call of the page when it is still going on: the next test
// must not find the call of this one.
async function hangup(page: Page): Promise<void> {
	const button = page.getByRole("button", { name: "End call" });

	if (await button.isVisible()) {
		await button.click();
	}
}

// closePair ends the call of the test and releases the browsers: only the
// runner closes the pages it created itself.
async function closePair(pair: Pair): Promise<void> {
	await hangup(pair.caller.page);
	await pair.caller.context.close();
	await pair.callee.context.close();
}

let accounts: { alice: Account; bob: Account };

test.beforeAll(async ({ baseURL, playwright }) => {
	// The registration waits for the rate limit window of a repeated run.
	test.setTimeout(180_000);

	const api = await playwright.request.newContext({ baseURL });

	try {
		const alice = await register(api, CALLER_EMAIL, "caller");
		const bob = await register(api, CALLEE_EMAIL, "callee");
		await createChat(api, alice, bob);
		accounts = { alice, bob };
	} finally {
		await api.dispose();
	}
});

// openPair opens the chat of the accounts in two browsers.
async function openPair(
	request: APIRequestContext,
	browser: Browser,
): Promise<Pair> {
	await waitForNoCall(request, accounts.alice);
	await waitForNoCall(request, accounts.bob);

	const caller = await open(browser, accounts.alice, accounts.bob);
	const callee = await open(browser, accounts.bob, accounts.alice);

	return { callee, caller };
}

test("the media of the call reaches both sides", async ({
	browser,
	request,
}) => {
	const pair = await openPair(request, browser);

	try {
		await callAndAccept(pair);
		await expectMedia(pair.caller.page);
		await expectMedia(pair.callee.page);
	} finally {
		await closePair(pair);
	}
});

test("a second tab of the caller does not end the call", async ({
	browser,
	request,
}) => {
	const pair = await openPair(request, browser);

	try {
		await callAndAccept(pair);
		await expectMedia(pair.caller.page);

		// Another page of the same user learns about the call from the
		// server. It must leave it alone: the call of the first page goes on.
		const second = await pair.caller.context.newPage();
		await second.goto("/chat");
		await second
			.getByRole("button", { name: `@${pair.callee.account.user.nick}` })
			.click();
		await second.close();

		await expectMedia(pair.caller.page);
	} finally {
		await closePair(pair);
	}
});

test("a reload ends the call for the peer", async ({ browser, request }) => {
	const pair = await openPair(request, browser);

	try {
		await callAndAccept(pair);
		await expectMedia(pair.callee.page);

		// The page that goes away tells the server about it: the peer sees
		// the end of the call instead of waiting for the ring to time out.
		await pair.caller.page.reload();

		await expect(
			pair.callee.page.getByText("The peer disconnected"),
		).toBeVisible();
	} finally {
		await closePair(pair);
	}
});
