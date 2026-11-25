import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../types/api.ts";
import { setActiveAccountKey } from "./init.ts";
import { messagesRepo } from "./messagesRepo.ts";

function msg(id: string, createdAt: string, text: string): Message {
	return {
		id,
		chatId: "chat-1",
		fromId: "alice:test",
		fromNick: "alice",
		text,
		createdAt,
	};
}

let mockRevokeObjectURL = vi.fn((_url: string) => undefined);

beforeEach(() => {
	setActiveAccountKey("alice:test");
	// Bind: the assertions below look the mock up through URL, which would
	// otherwise lose the receiver.
	mockRevokeObjectURL = vi.fn((_url: string) => undefined);
	URL.revokeObjectURL = mockRevokeObjectURL;
});

describe("messagesRepo.getByChat ordering", () => {
	it("keeps a newer client-format message last even when it shares a second with server-format messages", async () => {
		// Server (RFC3339Nano, trailing zeros trimmed) messages in the
		// same second: exact-second and 900ms.
		const oldExact = msg("old-exact", "2026-08-26T14:45:09Z", "old exact");
		const old900 = msg("old-900", "2026-08-26T14:45:09.9Z", "old 900");
		// A newer client (toISOString) message at 973ms.
		const newClient = msg(
			"new-client",
			"2026-08-26T14:45:09.973Z",
			"new client",
		);

		// Insert in shuffled order to prove sorting is applied.
		await messagesRepo.upsertMany([newClient, old900, oldExact]);

		const ordered = await messagesRepo.getByChat("chat-1");
		expect(ordered.map((m) => m.id)).toEqual([
			"old-exact",
			"old-900",
			"new-client",
		]);
	});

	it("sorts across seconds numerically", async () => {
		await messagesRepo.upsertMany([
			msg("m2", "2026-08-26T14:45:10.100Z", "second"),
			msg("m1", "2026-08-26T14:45:09.900Z", "first"),
		]);

		const ordered = await messagesRepo.getByChat("chat-1");
		expect(ordered.map((m) => m.id)).toEqual(["m1", "m2"]);
	});

	it("does not leak messages between accounts", async () => {
		await messagesRepo.upsertMany([
			msg("alice-msg", "2026-08-26T14:45:09Z", "alice only"),
		]);

		setActiveAccountKey("bob:test");
		expect(await messagesRepo.getByChat("chat-1")).toEqual([]);
	});
});

describe("messagesRepo lookups", () => {
	it("finds by id and respects the chat boundary", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		expect((await messagesRepo.getById("chat-1", "m1"))?.text).toBe("one");
		expect(await messagesRepo.getById("chat-1", "missing")).toBeUndefined();
		expect(await messagesRepo.getById("other-chat", "m1")).toBeUndefined();
		expect((await messagesRepo.getByIdAny("m1"))?.text).toBe("one");
		expect(await messagesRepo.getByIdAny("missing")).toBeUndefined();
	});
});

describe("messagesRepo mutations", () => {
	it("preserves queued status and read state on re-upsert", async () => {
		await messagesRepo.upsert(
			{ ...msg("m1", "2026-08-26T14:45:09Z", "one") },
			"queued",
		);
		await messagesRepo.upsert(msg("m1", "2026-08-26T14:45:09Z", "one"));

		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("queued");

		await messagesRepo.updateDeliveryStatus("m1", "read", ["bob:test"]);
		await messagesRepo.upsert({
			...msg("m1", "2026-08-26T14:45:09Z", "one"),
			deliveryStatus: "delivered",
		});

		const stored = await messagesRepo.getById("chat-1", "m1");
		expect(stored?.deliveryStatus).toBe("read");
		expect(stored?.readBy).toEqual(["bob:test"]);
	});

	it("applies and removes deletes within the chat", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		await messagesRepo.applyDelete("chat-1", "missing");
		await messagesRepo.applyDelete("other-chat", "m1");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("sent");

		await messagesRepo.applyDelete("chat-1", "m1");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe(
			"deleted",
		);

		await messagesRepo.remove("other-chat", "m1");
		expect(await messagesRepo.getById("chat-1", "m1")).toBeTruthy();
		await messagesRepo.remove("chat-1", "missing");
		await messagesRepo.remove("chat-1", "m1");
		expect(await messagesRepo.getById("chat-1", "m1")).toBeUndefined();
	});

	it("marks statuses within the chat", async () => {
		await messagesRepo.upsertMany([msg("m1", "2026-08-26T14:45:09Z", "one")]);

		await messagesRepo.markStatus("chat-1", "missing", "failed");
		await messagesRepo.markStatus("other-chat", "m1", "failed");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("sent");

		await messagesRepo.markStatus("chat-1", "m1", "failed");
		expect((await messagesRepo.getById("chat-1", "m1"))?.status).toBe("failed");
	});

	it("tracks pending, delivery and read ids", async () => {
		await messagesRepo.upsertMany([
			msg("m1", "2026-08-26T14:45:09Z", "one"),
			msg("m2", "2026-08-26T14:45:10Z", "two"),
		]);
		await messagesRepo.markStatus("chat-1", "m1", "queued");

		expect((await messagesRepo.getPending()).map((m) => m.id)).toEqual(["m1"]);

		await messagesRepo.updateDeliveryStatus("missing", "delivered");
		await messagesRepo.updateDeliveryStatus("m2", "delivered");
		expect((await messagesRepo.getById("chat-1", "m2"))?.deliveryStatus).toBe(
			"delivered",
		);

		await messagesRepo.markAsRead([]);
		await messagesRepo.markAsRead(["m1", "missing"]);
		expect(await messagesRepo.getReadMessageIds()).toEqual(["m1"]);
	});
});

describe("messagesRepo local previews", () => {
	it("releases the local preview URL when the server copy replaces it", async () => {
		const optimistic: Message = {
			...msg("m-photo", "2026-01-01T00:00:00Z", ""),
			encrypted: true,
			files: [
				{
					id: "local-1",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url: "blob:local-1",
					hash: "h1",
				},
			],
		};
		await messagesRepo.upsert(optimistic, "queued");

		const server: Message = {
			...optimistic,
			files: [
				{
					id: "server-1",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url: "/api/files/server-1",
					hash: "h1",
				},
			],
		};
		await messagesRepo.upsert(server);

		// The optimistic row rendered the picked file from this URL; the
		// server copy does not reference it any more.
		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:local-1");
		expect(
			(await messagesRepo.getById("chat-1", "m-photo"))?.files?.[0]?.url,
		).toBe("/api/files/server-1");
	});

	it("releases previews in upsertMany and after deletions", async () => {
		const local = (id: string, url: string): Message => ({
			...msg(id, "2026-01-01T00:00:00Z", ""),
			encrypted: true,
			files: [
				{
					id: "local-1",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url,
					hash: "h1",
				},
			],
		});
		const server = (id: string, url: string): Message => ({
			...local(id, url),
			files: [
				{
					id: "server-1",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url,
					hash: "h1",
				},
			],
		});

		// Delta/sync path: upsertMany replaces the optimistic row wholesale.
		await messagesRepo.upsertMany([local("m-many", "blob:many")], "queued");
		await messagesRepo.upsertMany([server("m-many", "/api/files/1")]);
		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:many");

		// A local row deleted outright (failed send cancelled by the user).
		await messagesRepo.upsert(local("m-del", "blob:del"), "failed");
		await messagesRepo.remove("chat-1", "m-del");
		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:del");

		// A tombstone hides the attachments, so their previews are dead too.
		await messagesRepo.upsert(local("m-tomb", "blob:tomb"), "failed");
		await messagesRepo.applyDelete("chat-1", "m-tomb");
		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:tomb");
		expect(
			(await messagesRepo.getById("chat-1", "m-tomb"))?.files,
		).toBeUndefined();
	});

	it("releases a preview when the row keeps no files at all", async () => {
		await messagesRepo.upsert(
			{
				...msg("m-strip", "2026-01-01T00:00:00Z", ""),
				files: [
					{
						id: "local-1",
						mimeType: "image/bmp",
						size: 3,
						originalName: "cat.bmp",
						fileType: "photo",
						url: "blob:strip",
						hash: "h1",
					},
				],
			},
			"queued",
		);
		await messagesRepo.upsert(msg("m-strip", "2026-01-01T00:00:00Z", "edited"));

		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:strip");
	});

	it("removes every message of a chat and releases its previews", async () => {
		await messagesRepo.upsert({
			...msg("m-chat-a", "2026-01-01T00:00:00Z", ""),
			files: [
				{
					id: "local-1",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url: "blob:chat-a",
					hash: "h1",
				},
			],
		});
		await messagesRepo.upsert({
			...msg("m-chat-b", "2026-01-01T00:00:00Z", "keep"),
			chatId: "chat-2",
		});

		await messagesRepo.removeByChat("chat-1");

		expect(await messagesRepo.getById("chat-1", "m-chat-a")).toBeUndefined();
		expect(await messagesRepo.getById("chat-2", "m-chat-b")).toBeDefined();
		expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:chat-a");
	});

	it("keeps a local preview that the new row still references", async () => {
		const local: Message = {
			...msg("m-keep", "2026-01-01T00:00:00Z", "hi"),
			files: [
				{
					id: "local-2",
					mimeType: "image/bmp",
					size: 3,
					originalName: "cat.bmp",
					fileType: "photo",
					url: "blob:local-2",
					hash: "h2",
				},
			],
		};
		await messagesRepo.upsert(local, "queued");
		await messagesRepo.upsert({ ...local, text: "edited" });

		expect(mockRevokeObjectURL).not.toHaveBeenCalledWith("blob:local-2");
	});
});
