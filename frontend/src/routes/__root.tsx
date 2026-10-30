import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { NotificationToast } from "../components/NotificationToast.tsx";
import i18n, { pickLang } from "../i18n.ts";
import { AudioProvider } from "../useAudioPlayer.tsx";
import { AuthProvider } from "../useAuth.tsx";

function RootDocument() {
	useEffect(() => {
		function updateLang() {
			document.documentElement.lang = pickLang(i18n.language);
		}
		updateLang();
		i18n.on("languageChanged", updateLang);
		return () => {
			i18n.off("languageChanged", updateLang);
		};
	}, []);

	return (
		<MantineProvider defaultColorScheme="dark">
			<Notifications />
			<AudioProvider>
				<AuthProvider>
					<ErrorBoundary>
						<Outlet />
					</ErrorBoundary>
					<NotificationToast />
				</AuthProvider>
			</AudioProvider>
		</MantineProvider>
	);
}

function NotFound() {
	return (
		<div style={{ padding: 24, textAlign: "center" }}>
			<p>Page not found.</p>
			<Link to="/">Back to home</Link>
		</div>
	);
}

export const Route = createRootRoute({
	component: RootDocument,
	notFoundComponent: NotFound,
});
