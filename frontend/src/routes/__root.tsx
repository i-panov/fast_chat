import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRootRoute, Outlet } from "@tanstack/react-router";
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

export const Route = createRootRoute({
	component: RootDocument,
});
