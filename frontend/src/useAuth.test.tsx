import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitUnauthorized } from "./utils/authEvents.ts";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("./router.tsx", () => ({
	getRouter: () => ({ navigate }),
}));

const { AuthProvider, useAuth } = await import("./useAuth.tsx");

function wrapper({ children }: { children: ReactNode }) {
	return <AuthProvider>{children}</AuthProvider>;
}

function account(token: string, nick: string) {
	return {
		token,
		user: { id: `${nick}:test`, nick },
		email: `${nick}@example.com`,
		expiresAt: "2027-01-01T00:00:00Z",
	};
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	vi.clearAllMocks();
});

describe("useAuth", () => {
	it("throws outside the provider", () => {
		expect(() => renderHook(() => useAuth())).toThrow(
			"useAuth must be used within AuthProvider",
		);
	});

	it("starts empty and tolerates corrupted storage", () => {
		localStorage.setItem("accounts", "corrupted{");

		const { result } = renderHook(() => useAuth(), { wrapper });

		expect(result.current.accounts).toEqual([]);
		expect(result.current.activeAccount).toBeNull();
	});

	it("adds the first account and activates it", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});

		expect(result.current.accounts).toHaveLength(1);
		expect(result.current.activeAccount?.token).toBe("t1");
		expect(sessionStorage.getItem("activeToken")).toBe("t1");
		expect(localStorage.getItem("activeToken")).toBe("t1");
	});

	it("ignores duplicate tokens", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});

		expect(result.current.accounts).toHaveLength(1);
	});

	it("switches between accounts", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
			result.current.addAccount(
				"t2",
				{ id: "b:test", nick: "b" },
				"b@x",
				"2027",
			);
		});
		expect(result.current.activeAccount?.token).toBe("t2");

		act(() => {
			result.current.switchAccount("t1");
		});

		expect(result.current.activeAccount?.token).toBe("t1");
		expect(sessionStorage.getItem("activeToken")).toBe("t1");
	});

	it("removing the active account falls through to the next", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.addAccount(
				"t2",
				{ id: "b:test", nick: "b" },
				"b@x",
				"2027",
			);
		});
		act(() => {
			result.current.switchAccount("t1");
		});
		act(() => {
			result.current.removeAccount("t1");
		});

		expect(result.current.activeAccount?.token).toBe("t2");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("removing the last account logs out to login", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.removeAccount("t1");
		});

		expect(result.current.activeAccount).toBeNull();
		expect(navigate).toHaveBeenCalledWith({
			to: "/login",
			search: { add: undefined },
		});
	});

	it("removing an inactive account keeps the session", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.addAccount(
				"t2",
				{ id: "b:test", nick: "b" },
				"b@x",
				"2027",
			);
		});
		act(() => {
			result.current.removeAccount("t2");
		});

		expect(result.current.activeAccount?.token).toBe("t1");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("logout removes the active account", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.logout();
		});

		expect(result.current.accounts).toEqual([]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/login",
			search: { add: undefined },
		});
	});

	it("rotates tokens and follows the active session", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
			result.current.updateAccountToken("t1", "t2", "2028");
		});

		expect(result.current.activeAccount?.token).toBe("t2");
		expect(sessionStorage.getItem("activeToken")).toBe("t2");
		expect(localStorage.getItem("activeToken")).toBe("t2");
	});

	it("resolves the active token from the session first", () => {
		localStorage.setItem(
			"accounts",
			JSON.stringify([account("t1", "a"), account("t2", "b")]),
		);
		localStorage.setItem("activeToken", "t2");
		sessionStorage.setItem("activeToken", "t1");

		const { result } = renderHook(() => useAuth(), { wrapper });

		expect(result.current.activeAccount?.token).toBe("t1");
	});

	it("falls back to the last active token and persists the session", () => {
		localStorage.setItem(
			"accounts",
			JSON.stringify([account("t1", "a"), account("t2", "b")]),
		);
		localStorage.setItem("activeToken", "t2");

		const { result } = renderHook(() => useAuth(), { wrapper });

		expect(result.current.activeAccount?.token).toBe("t2");
		expect(sessionStorage.getItem("activeToken")).toBe("t2");
	});

	it("falls back to the first account", () => {
		localStorage.setItem("accounts", JSON.stringify([account("t1", "a")]));

		const { result } = renderHook(() => useAuth(), { wrapper });

		expect(result.current.activeAccount?.token).toBe("t1");
	});

	it("syncs accounts arriving from another tab", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });
		expect(result.current.accounts).toEqual([]);

		act(() => {
			localStorage.setItem("accounts", JSON.stringify([account("t9", "z")]));
			window.dispatchEvent(new StorageEvent("storage", { key: "accounts" }));
		});

		expect(result.current.accounts.map((a) => a.token)).toEqual(["t9"]);
	});

	it("drops the account on an unauthorized event", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});

		act(() => {
			emitUnauthorized("t1");
		});

		expect(result.current.accounts).toEqual([]);
		expect(navigate).toHaveBeenCalledWith({
			to: "/login",
			search: { add: undefined },
		});
	});

	it("keeps the session when another account is unauthorized", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.addAccount(
				"t2",
				{ id: "b:test", nick: "b" },
				"b@x",
				"2027",
			);
		});

		act(() => {
			emitUnauthorized("t2");
		});

		expect(result.current.activeAccount?.token).toBe("t1");
		expect(navigate).not.toHaveBeenCalled();
	});

	it("scrubs the last-active pointer when its account is removed", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});
		act(() => {
			result.current.addAccount(
				"t2",
				{ id: "b:test", nick: "b" },
				"b@x",
				"2027",
			);
		});
		expect(localStorage.getItem("activeToken")).toBe("t2");

		act(() => {
			result.current.removeAccount("t2");
		});

		expect(localStorage.getItem("activeToken")).toBeNull();
	});

	it("merges accounts arriving from another tab without dropping local ones", () => {
		const { result } = renderHook(() => useAuth(), { wrapper });

		act(() => {
			result.current.addAccount(
				"t1",
				{ id: "a:test", nick: "a" },
				"a@x",
				"2027",
			);
		});

		// Another tab wrote only its own account on top of an empty list.
		act(() => {
			localStorage.setItem("accounts", JSON.stringify([account("t9", "z")]));
			window.dispatchEvent(new StorageEvent("storage", { key: "accounts" }));
		});

		expect(result.current.accounts.map((a) => a.token).sort()).toEqual([
			"t1",
			"t9",
		]);
	});
});
