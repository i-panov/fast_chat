import { MantineProvider } from "@mantine/core";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { NotificationToast } from "../components/NotificationToast.tsx";
import i18n from "../i18n.ts";
import { AudioProvider } from "../useAudioPlayer.tsx";
import { AuthProvider } from "../useAuth.tsx";

function RootDocument() {
	useEffect(() => {
		function updateLang() {
			document.documentElement.lang = i18n.language.split("-")[0];
		}
		updateLang();
		i18n.on("languageChanged", updateLang);
		return () => {
			i18n.off("languageChanged", updateLang);
		};
	}, []);

	return (
		<MantineProvider defaultColorScheme="dark">
			<AudioProvider>
				<AuthProvider>
					<Outlet />
					<NotificationToast />
				</AuthProvider>
			</AudioProvider>
		</MantineProvider>
	);
}

export const Route = createRootRoute({
	component: RootDocument,
});
