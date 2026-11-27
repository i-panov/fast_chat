import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { encodeServerBackup, encryptBackupData } from "./backup.ts";
import { generateIdentityKeyPair, generateKeyPair } from "./crypto.ts";
import {
	confirmIdentityReplacement,
	confirmNewKey,
	discardRecoveryAndGenerate,
	ensureAccountKeys,
	getMyKeyPair,
	getRecipientDeviceKeys,
	IdentityReplacementRequiredError,
	KeyPublishError,
} from "./keys.ts";

let serverPublicKey = "";
let serverIdentityPublicKey = "";
let serverVersion = 1;
let serverRecipientKey = "";
let backupOnServer: string | null = null;
let deleteCalls: number[] = [];
let uploadFails = false;

vi.mock("../api.ts", () => ({
	uploadPublicKey: vi.fn(() => {
		if (uploadFails) throw new Error("network down");
	}),
	getPublicKey: vi.fn((_token: string, userId: string) => {
		if (userId === "bob:test") {
			return {
				publicKey: serverRecipientKey,
				identityPublicKey: "",
				masterKeyVersion: 1,
			};
		}
		return {
			publicKey: serverPublicKey,
			identityPublicKey: serverIdentityPublicKey,
			masterKeyVersion: serverVersion,
		};
	}),
	getKeyBackup: vi.fn(() => {
		if (backupOnServer === null) throw new Error("http 404: no backup");
		return { backup: backupOnServer };
	}),
	setKeyBackup: vi.fn((_token: string, backup: string) => {
		backupOnServer = backup;
	}),
	deleteKeyBackup: vi.fn((_token: string, version: number) => {
		deleteCalls.push(version);
		backupOnServer = null;
	}),
	getSessions: vi.fn(() =>
		Promise.resolve({ currentSessionId: "s1", sessions: [] }),
	),
}));

let scopeCounter = 0;
function freshScope() {
	setActiveAccountKey(`identity-${scopeCounter++}:test.local`);
}

describe("identity replacement guard", () => {
	beforeEach(() => {
		freshScope();
		serverPublicKey = "";
		serverIdentityPublicKey = "";
		serverVersion = 1;
		backupOnServer = null;
		deleteCalls = [];
		uploadFails = false;
		vi.clearAllMocks();
	});

	it("requires a separate confirmation before replacing a published identity", async () => {
		serverPublicKey = "server-key";
		serverIdentityPublicKey = "published-identity";
		serverVersion = 2;

		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(Error);
		confirmNewKey();
		let identityEvent = false;
		const handler = () => {
			identityEvent = true;
		};
		window.addEventListener("e2ee:identity-replacement-needed", handler);
		await expect(ensureAccountKeys("token")).rejects.toBeInstanceOf(
			IdentityReplacementRequiredError,
		);
		window.removeEventListener("e2ee:identity-replacement-needed", handler);
		expect(identityEvent).toBe(true);
		expect(await getMyKeyPair()).toBeNull();

		confirmIdentityReplacement();
		const generated = await ensureAccountKeys("token");
		expect(generated.privateKey).toBeTruthy();
	});

	it("generates without the extra confirmation when no identity is published", async () => {
		confirmNewKey();
		const generated = await ensureAccountKeys("token");
		expect(generated.privateKey).toBeTruthy();
	});

	it("classifies the identity for the discard warning", async () => {
		const { checkIdentityForDiscard } = await import("./keys.ts");
		serverIdentityPublicKey = "server-identity";
		expect(await checkIdentityForDiscard("token")).toBe("missing");

		const identity = await generateIdentityKeyPair();
		await metaRepo.setNoNotify("e2ee.identityPublicKey", identity.publicKey);
		await metaRepo.setNoNotify("e2ee.identityPrivateKey", identity.privateKey);
		expect(await checkIdentityForDiscard("token")).toBe("mismatch");

		serverIdentityPublicKey = identity.publicKey;
		expect(await checkIdentityForDiscard("token")).toBe("ok");
	});
});

describe("discard recovery ordering", () => {
	beforeEach(() => {
		freshScope();
		serverPublicKey = "server-key";
		serverIdentityPublicKey = "";
		serverVersion = 4;
		backupOnServer = null;
		deleteCalls = [];
		uploadFails = false;
		vi.clearAllMocks();
	});

	it("keeps the old backup when publishing the replacement fails", async () => {
		const stale = await generateKeyPair();
		const identity = await generateIdentityKeyPair();
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 4,
			password: await encryptBackupData("old", {
				keyPair: stale,
				identityKeyPair: identity,
				keyVersion: 4,
			}),
		});
		uploadFails = true;

		await expect(discardRecoveryAndGenerate("token")).rejects.toBeInstanceOf(
			KeyPublishError,
		);
		expect(backupOnServer).not.toBeNull();
		expect(deleteCalls).toHaveLength(0);
	});

	it("deletes the old backup only after the replacement is published", async () => {
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 4,
			password: "b2xk",
		});

		const fresh = await discardRecoveryAndGenerate("token");
		expect(fresh.privateKey).toBeTruthy();
		expect(deleteCalls).toEqual([4]);
		expect(backupOnServer).toBeNull();
	});
});

describe("hasServerKeyBackup", () => {
	beforeEach(() => {
		freshScope();
		serverPublicKey = "";
		serverIdentityPublicKey = "";
		serverVersion = 1;
		backupOnServer = null;
		deleteCalls = [];
		uploadFails = false;
		vi.clearAllMocks();
	});

	it("does not advertise a stale backup as usable", async () => {
		const { hasServerKeyBackup } = await import("./keys.ts");
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 1,
			password: "b2xk",
		});
		await metaRepo.setNoNotify("e2ee.keyVersion", 3);
		expect(await hasServerKeyBackup("token")).toBe(false);
	});

	it("reports a backup that matches the local key version", async () => {
		const { hasServerKeyBackup } = await import("./keys.ts");
		backupOnServer = encodeServerBackup({
			v: 4,
			masterKeyVersion: 1,
			password: "b2xk",
		});
		expect(await hasServerKeyBackup("token")).toBe(true);
	});
});

describe("recipient key pinning", () => {
	beforeEach(() => {
		freshScope();
		serverRecipientKey = "";
		vi.clearAllMocks();
	});

	it("warns when a contact's pinned encryption key changes", async () => {
		serverRecipientKey = "first-recipient-key";
		const first = await getRecipientDeviceKeys("token", ["bob:test"]);
		expect(first.get("bob:test")?.[0]?.publicKey).toBe("first-recipient-key");

		// Expire the TTL cache without dropping the pin.
		const { getActiveAccountKey } = await import("../db/init.ts");
		const scope = getActiveAccountKey() ?? "";
		await metaRepo.setNoNotifyFor(scope, "e2ee.pubkey.bob:test", {
			publicKey: "first-recipient-key",
			keyVersion: 1,
			fetchedAt: 0,
		});
		serverRecipientKey = "attacker-or-rotated-key";

		let changed = 0;
		const off = (await import("./keys.ts")).onRecipientKeyChanged(() => {
			changed += 1;
		});
		const second = await getRecipientDeviceKeys("token", ["bob:test"]);
		off();
		expect(second.get("bob:test")?.[0]?.publicKey).toBe(
			"attacker-or-rotated-key",
		);
		expect(changed).toBe(1);
		expect(
			await metaRepo.getFor(scope, "e2ee.pinnedRecipientKey.bob:test"),
		).toBe("attacker-or-rotated-key");
	});
});
