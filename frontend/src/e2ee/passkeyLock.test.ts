import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActiveAccountKey } from "../db/init.ts";
import { metaRepo } from "../db/metaRepo.ts";
import { generateIdentityKeyPair, generateKeyPair } from "./crypto.ts";
import {
	IDENTITY_PRIVATE_KEY_META,
	IDENTITY_PUBLIC_KEY_META,
	KEY_VERSION_META,
	PASSKEY_LOCK_META,
	PRIVATE_KEY_META,
	PUBLIC_KEY_META,
} from "./keys.ts";
import {
	enablePasskey,
	PasskeyPrfMissingError,
	PasskeyPrfUnstableError,
	PasskeyPrfUnsupportedError,
} from "./passkeyLock.ts";

const create = vi.fn();
const get = vi.fn();

let scopeCounter = 0;
let scope: string;
let prf: ArrayBuffer;

function randomPrf(): ArrayBuffer {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return bytes.buffer;
}

function fakeCredential(
	prfValue: ArrayBuffer | null,
	enabled = true,
): Credential {
	return {
		rawId: new Uint8Array([1, 2, 3, 4]).buffer,
		getClientExtensionResults: () => ({
			prf: {
				enabled,
				...(prfValue === null ? {} : { results: { first: prfValue } }),
			},
		}),
	} as unknown as Credential;
}

beforeEach(async () => {
	scope = `passkey-${scopeCounter++}:test`;
	setActiveAccountKey(scope);
	const keyPair = await generateKeyPair();
	const identity = await generateIdentityKeyPair();
	await metaRepo.setNoNotifyFor(scope, PUBLIC_KEY_META, keyPair.publicKey);
	await metaRepo.setNoNotifyFor(scope, PRIVATE_KEY_META, keyPair.privateKey);
	await metaRepo.setNoNotifyFor(
		scope,
		IDENTITY_PUBLIC_KEY_META,
		identity.publicKey,
	);
	await metaRepo.setNoNotifyFor(
		scope,
		IDENTITY_PRIVATE_KEY_META,
		identity.privateKey,
	);
	await metaRepo.setNoNotifyFor(scope, KEY_VERSION_META, 1);

	prf = randomPrf();
	create.mockReset();
	get.mockReset();
	Object.defineProperty(navigator, "credentials", {
		value: { create, get },
		configurable: true,
	});
	Object.defineProperty(window, "isSecureContext", {
		value: true,
		configurable: true,
	});
	Object.defineProperty(globalThis, "PublicKeyCredential", {
		value: class {},
		configurable: true,
	});
});

describe("enablePasskey", () => {
	it("fails fast when the provider does not support PRF", async () => {
		create.mockResolvedValue(fakeCredential(null, false));

		await expect(enablePasskey()).rejects.toBeInstanceOf(
			PasskeyPrfUnsupportedError,
		);
		expect(get).not.toHaveBeenCalled();
		expect(await metaRepo.getFor(scope, PASSKEY_LOCK_META)).toBeUndefined();
	});

	it("fails when the confirmation returns no PRF", async () => {
		create.mockResolvedValue(fakeCredential(prf));
		get.mockResolvedValue(fakeCredential(null));

		await expect(enablePasskey()).rejects.toBeInstanceOf(
			PasskeyPrfMissingError,
		);
		expect(await metaRepo.getFor(scope, PASSKEY_LOCK_META)).toBeNull();
		expect(await metaRepo.getFor(scope, PRIVATE_KEY_META)).not.toBeNull();
	});

	it("rejects an unstable PRF instead of storing an unopenable wrapper", async () => {
		create.mockResolvedValue(fakeCredential(prf));
		get.mockResolvedValue(fakeCredential(randomPrf()));

		await expect(enablePasskey()).rejects.toBeInstanceOf(
			PasskeyPrfUnstableError,
		);
		expect(await metaRepo.getFor(scope, PASSKEY_LOCK_META)).toBeNull();
		expect(await metaRepo.getFor(scope, PRIVATE_KEY_META)).not.toBeNull();
	});

	it("stores the wrapper and removes the plaintext keys", async () => {
		create.mockResolvedValue(fakeCredential(prf));
		get.mockResolvedValue(fakeCredential(prf));

		await enablePasskey();

		expect(typeof (await metaRepo.getFor(scope, PASSKEY_LOCK_META))).toBe(
			"string",
		);
		expect(await metaRepo.getFor(scope, PRIVATE_KEY_META)).toBeNull();
		expect(await metaRepo.getFor(scope, IDENTITY_PRIVATE_KEY_META)).toBeNull();
	});
});
