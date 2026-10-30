import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../db/chatsRepo.ts";
import { getDB, setActiveAccountKey } from "../db/init.ts";
import { messagesRepo } from "../db/messagesRepo.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { pendingBlobsRepo } from "../db/pendingBlobsRepo.ts";
import type { StoredMessage } from "../db/schema.ts";
import type { KeyPair } from "../e2ee/crypto.ts";
import { generateKeyPair } from "../e2ee/crypto.ts";
import { clearLocalKeys } from "../e2ee/keys.ts";
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

	it("retries a failed send", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({ chatId: "c1", text: "x" });
		const [first] = await messagesRepo.getByChat("c1");
		const [op] = await outboxRepo.list();
		await outboxRepo.update({ ...op, status: "failed", attempts: 3 });
		await messagesRepo.markStatus("c1", first.id, "failed");

		await result.current.retryMessage("c1", first.id);

		const stored = await messagesRepo.getById("c1", first.id);
		expect(stored?.status).toBe("queued");
		const [retried] = await outboxRepo.list();
		expect(retried.attempts).toBe(0);
		expect(retried.status).toBeUndefined();
	});

	it("deletes a failed message outright", async () => {
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c1",
			text: "oops",
			pendingFiles: [pendingFile()],
		});
		const [first] = await messagesRepo.getByChat("c1");
		const [op] = await outboxRepo.list();
		await outboxRepo.update({ ...op, status: "failed", attempts: 1 });
		await messagesRepo.markStatus("c1", first.id, "failed");
		const [blobId] = op.kind === "send" ? op.pendingFileClientIds : [];
		expect(await pendingBlobsRepo.get(blobId)).not.toBeUndefined();

		await result.current.deleteMessage("c1", first.id);

		expect(await messagesRepo.getByChat("c1")).toEqual([]);
		expect(await outboxRepo.list()).toEqual([]);
		expect(await pendingBlobsRepo.get(blobId)).toBeUndefined();
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

	it("keeps the old files' keys when editing without new files", async () => {
		// Seed the local key pair with alice's test key so the edit path can
		// decrypt the current message and recover its file keys.
		if (keyStore.alice === null) throw new Error("no alice key");
		await clearLocalKeys();
		await metaRepo.setNoNotify("e2ee.publicKey", keyStore.alice.publicKey);
		await metaRepo.setNoNotify("e2ee.privateKey", keyStore.alice.privateKey);
		await chatsRepo.upsert({
			id: "c-kept",
			type: "group",
			name: "kept",
			ownerId: "alice:test",
			members: [
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			],
			createdAt: "2026-01-01T00:00:00Z",
		});
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c-kept",
			text: "with file",
			pendingFiles: [pendingFile()],
		});
		const [first] = await messagesRepo.getByChat("c-kept");

		await result.current.editMessage({
			chatId: "c-kept",
			messageId: first.id,
			text: "edited, same file",
		});

		const [stored] = await messagesRepo.getByChat("c-kept");
		const out = await decryptAsBob(stored);
		expect(out.text).toBe("edited, same file");
		// Without merging the kept files' keys this is empty and the
		// receiver can no longer decrypt the attachment.
		expect(Object.keys(out.fileKeys ?? {})).toHaveLength(1);
	});

	it("passes clearLocation through to the outbox edit op", async () => {
		await chatsRepo.upsert({
			id: "c-clearloc",
			type: "group",
			name: "clearloc",
			ownerId: "alice:test",
			members: [
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			],
			createdAt: "2026-01-01T00:00:00Z",
		});
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		await result.current.sendMessage({
			chatId: "c-clearloc",
			text: "here",
			location: { lat: 10, lng: 20 },
		});
		const [first] = await messagesRepo.getByChat("c-clearloc");

		await result.current.editMessage({
			chatId: "c-clearloc",
			messageId: first.id,
			text: "no longer here",
			clearLocation: true,
		});

		const ops = await outboxRepo.list();
		const edit = ops.find((o) => o.kind === "edit" && o.messageId === first.id);
		if (edit?.kind !== "edit") throw new Error("expected an edit op");
		expect(edit.clearLocation).toBe(true);
	});

	it("drops staged blobs when encryption is skipped", async () => {
		await chatsRepo.upsert({
			id: "c-nokey",
			type: "group",
			name: "nokey",
			ownerId: "alice:test",
			members: [
				{ id: "alice:test", nick: "alice" },
				{ id: "carol:test", nick: "carol" },
			],
			createdAt: "2026-01-01T00:00:00Z",
		});
		const db = await getDB();
		const blobsBefore = await db.getAll("pendingBlobs");
		const { result } = renderHook(() => useMessageSender({ token: "tok" }));

		// carol has no key: encryptForChat returns null after staging the
		// attachment blob.
		const ok = await result.current.sendMessage({
			chatId: "c-nokey",
			text: "will not send",
			pendingFiles: [pendingFile()],
		});

		expect(ok).toBe(false);
		expect(await messagesRepo.getByChat("c-nokey")).toEqual([]);
		// No orphan blobs left behind.
		expect(await db.getAll("pendingBlobs")).toHaveLength(blobsBefore.length);
	});
});
