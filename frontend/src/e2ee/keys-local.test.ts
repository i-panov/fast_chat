import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { ensureAccountKeys, getMyKeyPair } from "./keys.ts";

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn(),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
}));

const { uploadPublicKey } = await import("../api.ts");

let scopeCounter = 0;

beforeEach(() => {
	// Fresh scope per test: the module keeps an in-memory key cache that
	// the global IDB reset does not clear.
	setActiveAccountKey(`keys-${scopeCounter++}:test`);
	vi.clearAllMocks();
});

describe("keys local handling", () => {
	it("returns null without stored keys", async () => {
		expect(await getMyKeyPair()).toBeNull();
	});

	it("returns null for malformed stored keys", async () => {
		await metaRepo.setNoNotify("e2ee.publicKey", 123);
		await metaRepo.setNoNotify("e2ee.privateKey", 456);

		expect(await getMyKeyPair()).toBeNull();
	});

	it("requires a session to generate keys", async () => {
		await expect(ensureAccountKeys(undefined)).rejects.toThrow(
			"cannot generate E2E keys without an active session",
		);
	});

	it("keeps working when the public-key upload fails", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.mocked(uploadPublicKey).mockRejectedValueOnce(new Error("down"));

		const kp = await ensureAccountKeys("tok");

		expect(kp.publicKey).toBeTruthy();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("retries a previously failed upload", async () => {
		vi.mocked(uploadPublicKey).mockRejectedValueOnce(new Error("down"));
		const kp = await ensureAccountKeys("tok");

		vi.mocked(uploadPublicKey).mockResolvedValue({ status: "ok" });
		const again = await ensureAccountKeys("tok");

		expect(again.publicKey).toBe(kp.publicKey);
		expect(vi.mocked(uploadPublicKey)).toHaveBeenCalledTimes(2);
	});
});
