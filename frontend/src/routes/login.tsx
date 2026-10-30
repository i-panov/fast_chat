import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginPage } from "../pages/LoginPage.tsx";

function readAnyToken(): string | null {
	try {
		const session = sessionStorage.getItem("activeToken");
		if (session !== null) return session;
	} catch {
		// ignore
	}
	try {
		const raw = localStorage.getItem("accounts");
		if (!raw) return null;
		const accounts = JSON.parse(raw) as Array<{ token: string }>;
		if (!Array.isArray(accounts) || accounts.length === 0) return null;
		const last = localStorage.getItem("activeToken");
		if (last && accounts.some((a) => a.token === last)) return last;
		return accounts[0]?.token ?? null;
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/login")({
	validateSearch: (search: Record<string, unknown>) => ({
		add: typeof search.add === "string" ? search.add : undefined,
	}),
	beforeLoad: ({ search }) => {
		const s = search as Record<string, unknown>;
		// Allow explicit account-adding even when logged in (?add=1).
		// validateSearch only ever yields string|undefined, so no other
		// truthy forms need handling here.
		if (s.add === "1") return;
		if (readAnyToken() !== null) {
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw redirect({
				to: "/chat",
				search: { chatId: undefined, threadId: undefined },
			});
		}
	},
	component: LoginPage,
});
