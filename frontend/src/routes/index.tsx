import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "../useAuth.tsx";

function IndexPage() {
	const { activeAccount } = useAuth();
	if (activeAccount !== null) {
		return (
			<Navigate
				to="/chat"
				search={{ chatId: undefined, threadId: undefined }}
				replace
			/>
		);
	}
	return <Navigate to="/login" search={{ add: undefined }} replace />;
}

export const Route = createFileRoute("/")({
	component: IndexPage,
});
