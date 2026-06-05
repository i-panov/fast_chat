import { createFileRoute, redirect } from "@tanstack/react-router";
import { ChatPage } from "../pages/ChatPage.tsx";

function readActiveToken(): string | null {
	return sessionStorage.getItem("activeToken");
}

export const Route = createFileRoute("/chat")({
	beforeLoad: () => {
		if (readActiveToken() === null) {
			throw redirect({ to: "/login" });
		}
	},
	component: ChatPage,
});
