import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPage } from "../pages/ChatPage.tsx";

function readActiveToken(): string | null {
	return sessionStorage.getItem("activeToken");
}

export const Route = createFileRoute("/chat")({
	beforeLoad: () => {
		if (readActiveToken() === null) {
			// TanStack Router requires throwing a redirect() object; this
			// is framework control flow, not an application error.
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw redirect({ to: "/login" });
		}
	},
	component: ChatPage,
});
