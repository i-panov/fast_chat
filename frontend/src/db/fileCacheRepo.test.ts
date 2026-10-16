import { beforeEach, describe, expect, it } from "vitest";
import { fileCacheRepo } from "./fileCacheRepo.ts";
import { setActiveAccountKey } from "./init.ts";

function blob(text: string) {
	return new Blob([text], { type: "text/plain" });
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("fileCacheRepo", () => {
	it("stores and reads back a blob", async () => {
		await fileCacheRepo.put("https://srv/a", blob("abc"), "text/plain");

		const got = await fileCacheRepo.get("https://srv/a");
		expect(got?.mimeType).toBe("text/plain");
		expect(got?.size).toBe(3);
		expect(got?.url).toBe("https://srv/a");
	});

	it("returns undefined for a missing entry", async () => {
		expect(await fileCacheRepo.get("https://srv/missing")).toBeUndefined();
	});

	it("removes an entry", async () => {
		await fileCacheRepo.put("https://srv/a", blob("abc"), "text/plain");
		await fileCacheRepo.remove("https://srv/a");

		expect(await fileCacheRepo.get("https://srv/a")).toBeUndefined();
	});

	it("evicts the oldest entries past the limit", async () => {
		for (let i = 0; i < 201; i++) {
			await fileCacheRepo.put(`https://srv/f-${i}`, blob("x"), "text/plain");
		}

		expect(await fileCacheRepo.get("https://srv/f-0")).toBeUndefined();
		expect(await fileCacheRepo.get("https://srv/f-200")).not.toBeUndefined();
	});
});
