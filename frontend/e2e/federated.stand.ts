import {
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	expect,
	type Page,
	test,
} from "@playwright/test";

// Federated call stand: alice lives on server A (backend :8082, frontend
// :5175), bob lives on server B (backend :8081, frontend :5174). The chat
// between them is federated; the call must flow through the owner -> proxy
// signaling. Servers are started by hand, this file only drives browsers.

// The interface reads the account from the local storage on start.
const ACCOUNT_KEY = "accounts";
const TOKEN_KEY = "activeToken";

const BACKEND_A = "http://localhost:8082";
const BACKEND_B = "http://localhost:8081";
const FRONTEND_A = "http://localhost:5175";
const FRONTEND_B = "http://localhost:5174";

const ALICE_EMAIL = "fedalice@e2e.local";
const BOB_EMAIL = "fedbob@e2e.local";

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

// The camera control changes its label with the camera state: both labels
// name the same button, which an audio-only call must not show.
const CAMERA_CONTROL = /Turn camera/;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

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

async function register(
	request: APIRequestContext,
	email: string,
	nick: string,
): Promise<Account> {
	const verified = await request.post("/api/auth/verify-code", {
		data: { code: await sendCode(request, email), email },
	});
	const answer = (await verified.json()) as Verified;

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

async function open(
	browser: Browser,
	frontend: string,
	account: Account,
	peer: Account,
	opts?: { noVideo?: boolean },
): Promise<Session> {
	const context = await browser.newContext({ locale: "en-US" });

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

	// Audio-only mode: video requests fail, so acquireMedia falls back to
	// the microphone. The call must still connect without a camera.
	if (opts?.noVideo === true) {
		await context.addInitScript(() => {
			const trackedWindow = window as Window & {
				__addedTrackKinds?: string[];
			};
			const added: string[] = [];
			trackedWindow.__addedTrackKinds = added;

			// The original method is read through its descriptor: a plain
			// property read looks like an unbound method to the linter.
			const originalAddTrack = Object.getOwnPropertyDescriptor(
				RTCPeerConnection.prototype,
				"addTrack",
			)?.value as RTCPeerConnection["addTrack"];

			RTCPeerConnection.prototype.addTrack = function (
				this: RTCPeerConnection,
				...args: Parameters<RTCPeerConnection["addTrack"]>
			) {
				added.push(args[0].kind);

				return originalAddTrack.apply(this, args);
			};

			const original = navigator.mediaDevices.getUserMedia.bind(
				navigator.mediaDevices,
			);
			navigator.mediaDevices.getUserMedia = (
				constraints?: MediaStreamConstraints,
			) => {
				if (constraints?.video !== undefined && constraints.video !== false) {
					return Promise.reject(
						new DOMException("No video device", "NotFoundError"),
					);
				}

				return original(constraints);
			};
		});
	}

	const page = await context.newPage();

	const stream = page.waitForResponse(
		(response) =>
			response.url().includes("/api/events") && response.status() === 200,
	);

	await page.goto(`${frontend}/chat`);
	await stream;
	await page.getByRole("button", { name: `@${peer.user.nick}` }).click();

	return { account, context, page };
}

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

// addedTrackKinds returns the kinds of the tracks the page put into its
// connections. Only the audio-only contexts record them.
async function addedTrackKinds(page: Page): Promise<string[]> {
	return await page.evaluate(
		() =>
			(window as Window & { __addedTrackKinds?: string[] }).__addedTrackKinds ??
			[],
	);
}

async function hangup(page: Page): Promise<void> {
	const button = page.getByRole("button", { name: "End call" });

	if (!(await button.isVisible().catch(() => false))) {
		return;
	}

	// The reply has to arrive before the context closes: an aborted hangup
	// leaves the call registered until its TTL, and the next test reuses the
	// same accounts.
	const answered = page.waitForResponse(
		(response) =>
			response.request().method() === "POST" &&
			response.url().includes("/hangup"),
	);

	await button.click();
	await answered.catch(() => undefined);
	await expect(button).toBeHidden({ timeout: 20_000 });
}

let alice: Account;
let bob: Account;

test.beforeAll(async ({ playwright }) => {
	test.setTimeout(180_000);

	const apiA = await playwright.request.newContext({ baseURL: BACKEND_A });
	const apiB = await playwright.request.newContext({ baseURL: BACKEND_B });

	try {
		alice = await register(apiA, ALICE_EMAIL, "fedalice");
		bob = await register(apiB, BOB_EMAIL, "fedbob");

		// The federated private chat is created from the owner side.
		const created = await apiA.post("/api/chats", {
			headers: { Authorization: `Bearer ${alice.token}` },
			data: { type: "private", withUserId: bob.user.id },
		});

		if (!created.ok()) {
			throw new Error(
				`create federated chat answered ${created.status()}: ${await created.text()}`,
			);
		}
	} finally {
		await apiA.dispose();
		await apiB.dispose();
	}
});

test("federated media reaches both sides", async ({ browser }) => {
	const caller = await open(browser, FRONTEND_A, alice, bob);
	const callee = await open(browser, FRONTEND_B, bob, alice);

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${alice.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Accept" }).click();

		await expectMedia(caller.page);
		await expectMedia(callee.page);
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});

test("federated decline ends the call", async ({ browser }) => {
	const caller = await open(browser, FRONTEND_A, alice, bob);
	const callee = await open(browser, FRONTEND_B, bob, alice);

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${alice.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Decline" }).click();

		// The caller learns the end: no active call controls anymore.
		await expect(
			caller.page.getByRole("button", { name: "End call" }),
		).toBeHidden({ timeout: 20_000 });
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});

test("reload of the federated caller ends the call for the peer", async ({
	browser,
}) => {
	const caller = await open(browser, FRONTEND_A, alice, bob);
	const callee = await open(browser, FRONTEND_B, bob, alice);

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${alice.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Accept" }).click();

		await expectMedia(callee.page);

		// The page that goes away tells the server about it: the peer sees
		// the end of the call instead of waiting for the ring to time out.
		await caller.page.reload();

		await expect(callee.page.getByText("The peer disconnected")).toBeVisible({
			timeout: 30_000,
		});
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});

test("federated audio-only call connects without a camera", async ({
	browser,
}) => {
	const caller = await open(browser, FRONTEND_A, alice, bob, { noVideo: true });
	const callee = await open(browser, FRONTEND_B, bob, alice, { noVideo: true });

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${alice.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Accept" }).click();

		// No video frames are expected: the call is up when both sides show
		// the active call controls.
		await expect(
			caller.page.getByRole("button", { name: "End call" }),
		).toBeVisible({ timeout: 30_000 });
		await expect(
			callee.page.getByRole("button", { name: "End call" }),
		).toBeVisible();

		// The fallback acquires the microphone only: the connection carries
		// an audio track and no video track, the own preview stays hidden,
		// and the camera control is not offered at all.
		for (const page of [caller.page, callee.page]) {
			const kinds = await addedTrackKinds(page);

			expect(kinds).toContain("audio");
			expect(kinds).not.toContain("video");
			await expect(page.getByLabel("Own video")).toBeHidden();
			await expect(
				page.getByRole("button", { name: CAMERA_CONTROL }),
			).toHaveCount(0);
		}
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});

test("federated media reaches both sides in the reverse direction", async ({
	browser,
}) => {
	const caller = await open(browser, FRONTEND_B, bob, alice);
	const callee = await open(browser, FRONTEND_A, alice, bob);

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${bob.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Accept" }).click();

		await expectMedia(caller.page);
		await expectMedia(callee.page);
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});

test("federated hangup of the callee ends the call for the caller", async ({
	browser,
}) => {
	const caller = await open(browser, FRONTEND_A, alice, bob);
	const callee = await open(browser, FRONTEND_B, bob, alice);

	try {
		await caller.page
			.getByRole("button", { name: "Call", exact: true })
			.click();

		await expect(
			callee.page.getByText(`Incoming call from ${alice.user.nick}`),
		).toBeVisible();
		await callee.page.getByRole("button", { name: "Accept" }).click();

		await expectMedia(caller.page);

		// The callee lives on the proxy server: its hangup travels to the
		// owner and the owner reports the end back to both sides.
		await callee.page.getByRole("button", { name: "End call" }).click();

		await expect(
			caller.page.getByRole("button", { name: "End call" }),
		).toBeHidden({ timeout: 20_000 });
	} finally {
		await hangup(caller.page);
		await caller.context.close();
		await callee.context.close();
	}
});
