// biome-ignore-all lint/security/noSecrets: the file has no secrets; a DOM selector and a generated test image are false positives.
import { generateKeyPairSync } from "node:crypto";
import {
	type APIRequestContext,
	type Browser,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";

// A photo sent from the web client must stay visible after the canonical
// server copy replaces the optimistic local one. Attachments in an encrypted
// chat travel as ciphertext, so the server sees no MIME type: the client has
// to carry the real metadata inside the encrypted content. When that metadata
// was dropped, a photo-only message turned into an empty bubble after sync.

const PHOTO_NAME = "cat.bmp";

// An 8x8 24-bit BMP built in code: a real, renderable image without a
// binary/base64 fixture in the repository. The server never sees these bytes
// (the upload is encrypted), it only needs the client to classify the file as
// a photo.
function photoBytes(): Buffer {
	const width = 8;
	const height = 8;
	const rowSize = width * 3; // 24 bytes, already 4-byte aligned
	const pixelBytes = rowSize * height;
	const buffer = Buffer.alloc(54 + pixelBytes);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(buffer.length, 2);
	buffer.writeUInt32LE(54, 10); // pixel data offset
	buffer.writeUInt32LE(40, 14); // DIB header size
	buffer.writeInt32LE(width, 18);
	buffer.writeInt32LE(height, 22);
	buffer.writeUInt16LE(1, 26); // planes
	buffer.writeUInt16LE(24, 28); // bits per pixel
	buffer.writeUInt32LE(pixelBytes, 34);
	for (let i = 0; i < width * height; i++) {
		// Bottom-up BGR rows: fill with an opaque colour so the image renders.
		buffer[54 + i * 3] = 0x40;
		buffer[54 + i * 3 + 1] = 0x80;
		buffer[54 + i * 3 + 2] = 0xc0;
	}

	return buffer;
}

const CREATE_KEY_RE = /Create new key|Создать новый ключ/;
const SEND_RE = /^(Send|Отправить)$/;
const LOAD_FAILED_RE = /Failed to load image|Не удалось загрузить изображение/;

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

async function register(
	request: APIRequestContext,
	email: string,
	nick: string,
	device: string,
): Promise<Account> {
	const sent = await request.post("/api/auth/send-code", { data: { email } });
	expect(sent.ok()).toBeTruthy();
	const { debugCode } = (await sent.json()) as { debugCode?: string };
	if (debugCode === undefined) throw new Error("no debug code");

	const verifiedResponse = await request.post("/api/auth/verify-code", {
		data: { email, code: debugCode, deviceId: device, deviceName: device },
	});
	expect(verifiedResponse.ok()).toBeTruthy();
	const verified = (await verifiedResponse.json()) as Verified;

	if (verified.isNew) {
		const registered = await request.post("/api/auth/complete-registration", {
			data: {
				setupToken: verified.setupToken,
				nick,
				deviceId: device,
				deviceName: device,
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

// A real X25519 public key for the peer: the sender seals the message key to
// every member's device, and a member without a key makes the send fail
// closed. The private half is unused here, the sender decrypts its own copy.
function x25519PublicKey(): string {
	const { publicKey } = generateKeyPairSync("x25519");
	// SPKI for X25519 ends with the 32 raw key bytes.
	const der = publicKey.export({ type: "spki", format: "der" });

	return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

async function openAs(
	browser: Browser,
	account: Account,
): Promise<{ page: Page; close: () => Promise<void> }> {
	const context = await browser.newContext({ locale: "en-US" });
	await context.addInitScript((stored) => {
		localStorage.setItem("accounts", JSON.stringify([stored]));
		localStorage.setItem("activeToken", stored.token);
		sessionStorage.setItem("activeToken", stored.token);
	}, account);
	const page = await context.newPage();
	await page.goto("/chat");

	return { page, close: () => context.close() };
}

// The first login asks before generating the account key; without it the send
// is refused (the chat is end-to-end encrypted). Both accounts of this test are
// fresh, so the prompt is deterministic and must not be silently skipped: a
// missing key would only surface later as an empty chat.
async function createAccountKey(page: Page): Promise<void> {
	const button = page.getByRole("button", { name: CREATE_KEY_RE });
	await expect(button).toBeVisible({ timeout: 20_000 });
	await button.click();
	await expect(page.getByRole("dialog")).toHaveCount(0, {
		timeout: 20_000,
	});
}

test("a sent photo survives the sync back from the server", async ({
	browser,
	request,
}) => {
	// Registration, key generation, an upload and a reload: the individual
	// waits add up past the project-wide 60s budget on a loaded machine.
	test.setTimeout(180_000);

	const suffix = Date.now().toString(36);
	const alice = await register(
		request,
		`photo-a-${suffix}@e2e.local`,
		`pa${suffix}`.slice(0, 20),
		"photo-a",
	);
	const bob = await register(
		request,
		`photo-b-${suffix}@e2e.local`,
		`pb${suffix}`.slice(0, 20),
		"photo-b",
	);

	const deviceKey = await request.put("/api/users/device-key", {
		headers: { Authorization: `Bearer ${bob.token}` },
		data: { publicKey: x25519PublicKey() },
	});
	expect(deviceKey.ok()).toBeTruthy();

	const created = await request.post("/api/chats", {
		headers: { Authorization: `Bearer ${alice.token}` },
		data: { type: "private", withUserId: bob.user.id },
	});
	expect(created.ok()).toBeTruthy();
	const { chat } = (await created.json()) as { chat: { id: string } };

	const { page, close } = await openAs(browser, alice);

	try {
		await createAccountKey(page);

		await page.getByText(`${bob.user.nick}`, { exact: false }).first().click();

		const picker = page.locator('input[type="file"]');
		await picker.setInputFiles({
			name: PHOTO_NAME,
			mimeType: "image/bmp",
			buffer: photoBytes(),
		});

		// Hold the upload until the optimistic row has been asserted: the row
		// exists before the upload starts (prepareFiles only stages the blob
		// locally), so this proves the bubble rendered the picked file itself
		// and did not wait for the server copy.
		let releaseUpload = () => {};
		let uploadStarted = () => {};
		const started = new Promise<void>((resolve) => {
			uploadStarted = resolve;
		});
		const held = new Promise<void>((resolve) => {
			releaseUpload = resolve;
		});
		await page.route("**/api/files/upload", async (route) => {
			uploadStarted();
			await held;
			await route.continue();
		});

		await expect(page.getByRole("button", { name: SEND_RE })).toBeVisible({
			timeout: 10_000,
		});
		await page.getByRole("button", { name: SEND_RE }).click();

		// The bubble must show a decoded image and no error text. Both halves
		// matter: a failure renders the red text instead of the image.
		const decodedImage = async (locator: Locator) => {
			await expect(locator).toBeVisible({ timeout: 20_000 });
			await expect(page.getByText(LOAD_FAILED_RE)).toHaveCount(0);
			expect(
				await locator.evaluate((img) => (img as HTMLImageElement).naturalWidth),
			).toBeGreaterThan(0);
		};
		await decodedImage(page.locator(`img[alt="${PHOTO_NAME}"]`).first());

		// The optimistic bubble already renders the local blob while the upload
		// is still held.
		await started;
		await decodedImage(page.locator(`img[alt="${PHOTO_NAME}"]`).first());
		releaseUpload();

		// The server row must belong to an encrypted message and carry the
		// client's plaintext hash. Only then does the restored photo prove the
		// metadata travelled inside the ciphertext rather than in a plaintext
		// file field. The sniffed MIME type is deliberately not asserted: it is
		// http.DetectContentType over ciphertext and is random.
		const sentFile = async () => {
			const response = await request.get(`/api/chats/${chat.id}/messages`, {
				headers: { Authorization: `Bearer ${alice.token}` },
			});
			const body = (await response.json()) as {
				messages: Array<{
					encrypted: boolean;
					files?: Array<{ hash?: string }>;
				}>;
			};

			return body.messages
				.flatMap((message) =>
					(message.files ?? []).map((file) => ({
						encrypted: message.encrypted,
						hash: file.hash,
					})),
				)
				.find((file) => file.hash !== undefined && file.hash !== "");
		};

		await expect
			.poll(async () => (await sentFile())?.hash ?? "", { timeout: 20_000 })
			.not.toBe("");
		expect((await sentFile())?.encrypted).toBe(true);

		// Reload: the message now comes from the server copy and is decrypted
		// again. Without the metadata inside the encrypted content the photo
		// disappears here and the bubble renders empty.
		await page.reload();
		await page.getByText(`${bob.user.nick}`, { exact: false }).first().click();
		const afterReload = page.locator(`img[alt="${PHOTO_NAME}"]`).first();
		await expect(afterReload).toBeVisible({ timeout: 20_000 });
		expect(
			await afterReload.evaluate(
				(img) => (img as HTMLImageElement).naturalWidth,
			),
		).toBeGreaterThan(0);

		// The full-screen viewer fetches the same ciphertext and has to decrypt
		// it too; before the fix it showed a broken image instead.
		await afterReload.click();
		const lightbox = page.locator(`img[alt="${PHOTO_NAME}"]`).last();
		await expect(lightbox).toBeVisible({ timeout: 10_000 });
		expect(
			await lightbox.evaluate((img) => (img as HTMLImageElement).naturalWidth),
		).toBeGreaterThan(0);
		await expect(page.getByText(LOAD_FAILED_RE)).toHaveCount(0);
	} finally {
		await close();
	}
});
