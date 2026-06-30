import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useAuth } from "../useAuth.tsx";

function IndexPage() {
	const { activeAccount } = useAuth();
	return <Navigate to={activeAccount !== null ? "/chat" : "/login"} />;
}

export const Route = createFileRoute("/")({
	component: IndexPage,
});
