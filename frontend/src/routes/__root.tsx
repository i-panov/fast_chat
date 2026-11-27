import { MantineProvider } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { LocalLockModal } from "../components/chat/LocalLockModal.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { NotificationToast } from "../components/NotificationToast.tsx";
import { useAppViewport } from "../hooks/useAppViewport.ts";
import i18n, { pickLang } from "../i18n.ts";
import { AudioProvider } from "../useAudioPlayer.tsx";
import { AuthProvider, useAuth } from "../useAuth.tsx";

// The auto-lock timers must run on every route, not only inside the chat
// page: otherwise a user who opens admin/settings leaves the master key
// unlocked indefinitely.
function GlobalLocalLock() {
	const { activeAccount } = useAuth();
	return <LocalLockModal activeToken={activeAccount?.token ?? null} />;
}

function RootDocument() {
	useAppViewport();
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
			{/* Errors must stay visible when the mobile keyboard is open:
			    the bottom-right default lands below the composer. */}
			<Notifications position="top-center" />
			<AudioProvider>
				<AuthProvider>
					<ErrorBoundary>
						<GlobalLocalLock />
						<Outlet />
					</ErrorBoundary>
					<NotificationToast />
				</AuthProvider>
			</AudioProvider>
		</MantineProvider>
	);
}

function NotFound() {
	const { t } = useTranslation();
	return (
		<div style={{ padding: 24, textAlign: "center" }}>
			<p>{t("notFound.title")}</p>
			<Link to="/">{t("notFound.back")}</Link>
		</div>
	);
}

export const Route = createRootRoute({
	component: RootDocument,
	notFoundComponent: NotFound,
});
