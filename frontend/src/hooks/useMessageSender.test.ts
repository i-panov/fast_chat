import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { StoredMessage } from "../db/schema.ts";
import type { KeyPair } from "../e2ee/crypto.ts";
import { generateKeyPair } from "../e2ee/crypto.ts";
import { decryptMessage } from "../e2ee/message.ts";
import type { PendingFile } from "../types/api.ts";

const keyStore = vi.hoisted(() => ({
	alice: null as KeyPair | null,
	bob: null as KeyPair | null,
}));

vi.mock("../api.ts", () => ({
	fileExistsByHash: vi.fn(() => Promise.resolve(false)),
	uploadPublicKey: vi.fn(),
	getPublicKey: vi.fn((_token: string, userId: string) => {
		if (userId === "alice:test" && keyStore.alice !== null) {
			return { publicKey: keyStore.alice.publicKey, keyVersion: "v" };
		}
		if (userId === "bob:test" && keyStore.bob !== null) {
			return { publicKey: keyStore.bob.publicKey, keyVersion: "v" };
		}
		return { publicKey: "", keyVersion: "" };
	}),
	getKeyBackup: vi.fn(() => {
		throw new Error("http 404: no key backup");
	}),
	setKeyBackup: vi.fn(),
	deleteKeyBackup: vi.fn(),
}));

vi.mock("../sync/syncEngine.ts", () => ({
	scheduleSync: vi.fn(),
}));

vi.mock("../useAuth", () => ({
	useAuth: () => ({
		activeAccount: {
			user: { id: "alice:test", nick: "alice" },
			token: "tok",
			email: "alice@example.com",
			expiresAt: "2027-01-01T00:00:00Z",
		},
	}),
}));

const { useMessageSender } = await import("./useMessageSender.ts");

function decryptAsBob(msg: StoredMessage) {
	if (keyStore.bob === null) throw new Error("no bob key");

	return decryptMessage(msg, "bob:test", keyStore.bob);
}

function pendingFile(): PendingFile {
	return {
		id: "pf-1",
		file: new File(["file content"], "a.txt", { type: "text/plain" }),
		blobUrl: "blob:pending-1",
		originalName: "a.txt",
		size: 12,
		mimeType: "text/plain",
		fileType: "file",
	};
}

beforeEach(async () => {
	setActiveAccountKey("alice:test");
	keyStore.alice = await generateKeyPair();
	keyStore.bob = await generateKeyPair();

	await chatsRepo.upsert({
		id: "c1",
		type: "group",
		name: "g",
		ownerId: "alice:test",
		members: [
			{ id: "alice:test", nick: "alice" },
			{ id: "bob:test", nick: "bob" },
		],
		createdAt: "2026-01-01T00:00:00Z",
	});
});

describe("useMessageSender", () => {
	it("sends an encrypted message with location", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c1",
			text: "hello",
			location: { lat: 10, lng: 20 },
		});

		const stored = await messagesRepo.getByChat("c1");
		expect(stored).toHaveLength(1);
		expect(stored[0].encrypted).toBe(true);
		expect(stored[0].text).not.toContain("hello");

		const out = await decryptAsBob(stored[0]);
		expect(out.text).toBe("hello");
		expect(out.location).toEqual({ lat: 10, lng: 20 });

		const ops = await outboxRepo.list();
		expect(ops).toHaveLength(1);
		expect(ops[0].kind).toBe("send");
	});

	it("encrypts attached files and stages blobs for upload", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c1",
			text: "with file",
			pendingFiles: [pendingFile()],
		});

		const stored = await messagesRepo.getByChat("c1");
		expect(stored).toHaveLength(1);
		expect(stored[0].files).toHaveLength(1);

		const out = await decryptAsBob(stored[0]);
		expect(out.text).toBe("with file");
		expect(Object.keys(out.fileKeys ?? {})).toHaveLength(1);

		const [sendOp] = await outboxRepo.list();
		if (sendOp.kind !== "send") throw new Error("expected a send op");
		expect(sendOp.pendingFileClientIds).toHaveLength(1);

		const staged = await pendingBlobsRepo.get(sendOp.pendingFileClientIds[0]);
		expect(staged?.encrypted).toBe(true);
	});

	it("edits a sent message", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({ chatId: "c1", text: "v1" });
		const [first] = await messagesRepo.getByChat("c1");

		await result.current.editMessage({
			chatId: "c1",
			messageId: first.id,
			text: "v2",
		});

		const stored = await messagesRepo.getByChat("c1");
		expect(stored).toHaveLength(1);
		const out = await decryptAsBob(stored[0]);
		expect(out.text).toBe("v2");
		expect(stored[0].editedAt).toBeTruthy();

		const ops = await outboxRepo.list();
		expect(ops.map((o) => o.kind)).toContain("edit");
	});

	it("deletes a queued message via the outbox path", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({ chatId: "c1", text: "bye" });
		const [first] = await messagesRepo.getByChat("c1");

		await result.current.deleteMessage("c1", first.id);

		const stored = await messagesRepo.getById("c1", first.id);
		expect(stored?.status).toBe("deleted");

		const ops = await outboxRepo.list();
		expect(ops.map((o) => o.kind)).toContain("delete");
	});

	it("cancels a queued send and drops its blobs", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c1",
			text: "oops",
			pendingFiles: [pendingFile()],
		});
		const [first] = await messagesRepo.getByChat("c1");
		const [sendOp] = await outboxRepo.list();
		if (sendOp.kind !== "send") throw new Error("expected a send op");
		const [blobId] = sendOp.pendingFileClientIds;
		expect(await pendingBlobsRepo.get(blobId)).not.toBeUndefined();

		await result.current.cancelSendMessage("c1", first.id);

		expect(await messagesRepo.getByChat("c1")).toEqual([]);
		expect(await outboxRepo.list()).toEqual([]);
		expect(await pendingBlobsRepo.get(blobId)).toBeUndefined();
	});
});
