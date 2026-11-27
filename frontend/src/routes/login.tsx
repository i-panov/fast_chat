import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginPage } from "../pages/LoginPage.tsx";
import { readAnyToken } from "../utils/activeToken.ts";

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
