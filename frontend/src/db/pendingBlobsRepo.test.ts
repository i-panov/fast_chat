import { beforeEach, describe, expect, it } from "vitest";
import { setActiveAccountKey } from "./init.ts";
import { pendingBlobsRepo } from "./pendingBlobsRepo.ts";

function blob() {
	return {
		id: "b1",
		blob: new Blob(["x"]),
		name: "a.txt",
		mimeType: "text/plain",
		size: 1,
		plaintextHash: "h",
		encrypted: true as const,
	};
}

beforeEach(() => {
	setActiveAccountKey("alice:test");
});

describe("pendingBlobsRepo", () => {
	it("stores and reads back a blob", async () => {
		await pendingBlobsRepo.put(blob());

		expect((await pendingBlobsRepo.get("b1"))?.name).toBe("a.txt");
		expect(await pendingBlobsRepo.get("missing")).toBeUndefined();
	});

	it("deletes blobs one by one and in bulk", async () => {
		await pendingBlobsRepo.put({ ...blob(), id: "b1" });
		await pendingBlobsRepo.put({ ...blob(), id: "b2" });

		await pendingBlobsRepo.delete("b1");
		expect(await pendingBlobsRepo.get("b1")).toBeUndefined();

		await pendingBlobsRepo.deleteMany(["b2"]);
		expect(await pendingBlobsRepo.get("b2")).toBeUndefined();

		await pendingBlobsRepo.deleteMany([]);
	});
});
