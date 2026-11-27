import { beforeEach, describe, expect, it } from "vitest";
import { readActiveToken, resolveActiveToken } from "./activeToken.ts";

function seedAccounts(tokens: string[]) {
	localStorage.setItem(
		"accounts",
		JSON.stringify(tokens.map((token) => ({ token }))),
	);
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe("activeToken", () => {
	it("drops a per-tab token whose account was removed in another tab", () => {
		sessionStorage.setItem("activeToken", "dead");

		expect(readActiveToken()).toBeNull();
		// The dead token is scrubbed, so the next read does not resurrect it.
		expect(sessionStorage.getItem("activeToken")).toBeNull();
	});

	it("falls through to a still stored account", () => {
		seedAccounts(["t2"]);
		sessionStorage.setItem("activeToken", "dead");

		expect(readActiveToken()).toBe("t2");
		expect(readActiveToken()).toBe("t2");
	});

	it("prefers the per-tab token of a stored account", () => {
		seedAccounts(["t1", "t2"]);
		localStorage.setItem("activeToken", "t2");
		sessionStorage.setItem("activeToken", "t1");

		expect(readActiveToken()).toBe("t1");
	});

	it("resolves and persists the last active account", () => {
		seedAccounts(["t1", "t2"]);
		localStorage.setItem("activeToken", "t2");
		sessionStorage.setItem("activeToken", "dead");

		expect(resolveActiveToken()).toBe("t2");
		expect(sessionStorage.getItem("activeToken")).toBe("t2");
	});

	it("keeps the last-active pointer when the session token is valid", () => {
		seedAccounts(["t1", "t2"]);
		localStorage.setItem("activeToken", "t2");
		sessionStorage.setItem("activeToken", "t1");

		expect(resolveActiveToken()).toBe("t1");
		expect(localStorage.getItem("activeToken")).toBe("t2");
	});
});
