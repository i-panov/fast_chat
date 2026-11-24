import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminPage } from "../pages/AdminPage.tsx";
import { readActiveToken } from "../utils/activeToken.ts";

export const Route = createFileRoute("/admin")({
	beforeLoad: () => {
		if (readActiveToken() === null) {
			// TanStack Router requires throwing a redirect() object; this
			// is framework control flow, not an application error.
			// eslint-disable-next-line @typescript-eslint/only-throw-error
			throw redirect({ to: "/login", search: { add: undefined } });
		}
	},
	component: AdminPage,
});
