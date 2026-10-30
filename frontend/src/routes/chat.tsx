import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPage } from "../pages/ChatPage.tsx";

function readActiveToken(): string | null {
	try {
		const session = sessionStorage.getItem("activeToken");
		if (session !== null) return session;
	} catch {
		// storage may be blocked
	}
	// A fresh tab has empty sessionStorage while localStorage still holds
	// accounts: let the AuthProvider restore the session instead of
	// bouncing a valid user to /login.
	try {
		const raw = localStorage.getItem("accounts");
		if (raw === null) return null;
		const accounts = JSON.parse(raw) as Array<{ token: string }>;
		if (!Array.isArray(accounts) || accounts.length === 0) return null;
		const last = localStorage.getItem("activeToken");
		if (last !== null && accounts.some((a) => a.token === last)) return last;
		return accounts[0]?.token ?? null;
	} catch {
		return null;
	}
}

export const Route = createFileRoute("/chat")({
	validateSearch: (search: Record<string, unknown>) => ({
		chatId: typeof search.chatId === "string" ? search.chatId : undefined,
		threadId: typeof search.threadId === "string" ? search.threadId : undefined,
	}),
	beforeLoad: () => {
		if (readActiveToken() === null) {
			// TanStack Router requires throwing a redirect() object; this
			// is framework control flow, not an application error.
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw redirect({ to: "/login", search: { add: undefined } });
		}
	},
	component: ChatPage,
});
