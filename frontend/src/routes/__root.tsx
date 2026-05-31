import { MantineProvider } from "@mantine/core";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AuthProvider } from "../useAuth.tsx";

function RootDocument() {
	return (
		<MantineProvider defaultColorScheme="dark">
			<AuthProvider>
				<Outlet />
			</AuthProvider>
		</MantineProvider>
	);
}

export const Route = createRootRoute({
	component: RootDocument,
});
