import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, getSessions, revokeDeviceSession } from "../../api.ts";
import type { SessionInfo } from "../../types/api.ts";
import { formatDateTime } from "../../utils/chat.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
	// Returning a promise lets the dialog keep its error visible when the
	// server rejects the global logout.
	onLogoutAll: () => void | Promise<void>;
}

function formatDate(value: string): string {
	return formatDateTime(value);
}

// The dialog lists the account's sessions. Per-device E2EE keys no longer
// exist (v3 uses one master key), so there is no key revocation here: the
// equivalent action is rotating the master key.
export function SessionsModal({ open, onClose, token, onLogoutAll }: Props) {
	const { t } = useTranslation();
	// On a phone the dialog takes the whole screen instead of squeezing the
	// rows into a narrow column.
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [loggingOut, setLoggingOut] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [errorTitle, setErrorTitle] = useState("sessions.errorTitle");

	useEffect(() => {
		if (!open || token === undefined) return;

		let cancelled = false;
		setLoading(true);
		setError(null);
		setErrorTitle("sessions.errorTitle");
		void getSessions(token)
			.then((result) => {
				if (!cancelled) {
					setSessions(result.sessions);
					setCurrentSessionId(result.currentSessionId);
				}
			})
			.catch(() => {
				if (!cancelled) setError(t("error.requestFailed"));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [open, token, t]);

	async function handleRevoke(sessionID: string) {
		if (token === undefined) return;
		setRevoking(sessionID);
		setError(null);
		try {
			await revokeDeviceSession(token, sessionID);
			setSessions((prev) => prev.filter((s) => s.id !== sessionID));
		} catch (err) {
			// A session that is already gone is not an error: drop the row.
			if (err instanceof ApiError && err.status === 404) {
				setSessions((prev) => prev.filter((s) => s.id !== sessionID));
			} else {
				setErrorTitle("sessions.actionErrorTitle");
				setError(t("error.requestFailed"));
			}
		} finally {
			setRevoking(null);
		}
	}

	async function handleLogoutAll() {
		if (loggingOut) return;
		if (!window.confirm(t("sessions.logoutAllConfirm"))) return;
		setLoggingOut(true);
		setError(null);
		try {
			await onLogoutAll();
			onClose();
		} catch {
			setErrorTitle("sessions.actionErrorTitle");
			setError(t("sessions.logoutAllFailed"));
		} finally {
			setLoggingOut(false);
		}
	}

	const hasOtherSessions = sessions.some(
		(session) => !session.current && session.id !== currentSessionId,
	);

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("sessions.title")}
			size="lg"
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="md">
				<Text size="xs" c="dimmed">
					{t("sessions.hint")}
				</Text>
				{hasOtherSessions && (
					<Text size="xs" c="dimmed">
						{t("sessions.clearedHint")}
					</Text>
				)}

				{loading ? (
					<Group justify="center">
						<Loader size="sm" />
					</Group>
				) : (
					<Stack gap="xs">
						{sessions.length === 0 && !error && (
							<Text size="sm" c="dimmed">
								{t("sessions.empty")}
							</Text>
						)}
						{sessions.map((session) => {
							// Trust both signals: the per-row flag and the id the
							// server reported for this request. A stale or
							// missing flag must not expose "end session" for
							// the device the user is currently on.
							const isCurrent =
								session.current || session.id === currentSessionId;

							return (
								<Paper key={session.id} withBorder p="sm" radius="sm">
									<Stack gap="xs">
										<Group
											justify="space-between"
											align="flex-start"
											gap="xs"
											wrap="wrap"
										>
											<Box style={{ minWidth: 0, flex: "1 1 200px" }}>
												<Text size="sm" fw={500} truncate>
													{session.deviceName || session.deviceId}
												</Text>
												<Text size="xs" c="dimmed">
													{t("sessions.lastSeen", {
														when: formatDate(session.lastSeenAt),
													})}
												</Text>
												<Text size="xs" c="dimmed">
													{t("sessions.created", {
														when: formatDate(session.createdAt),
													})}
												</Text>
											</Box>
											<Group gap={6} wrap="wrap">
												{isCurrent && (
													<Badge size="xs" variant="light">
														{t("sessions.thisDevice")}
													</Badge>
												)}
											</Group>
										</Group>
										{!isCurrent && (
											<Group gap="xs" justify="flex-end" wrap="wrap">
												<Button
													size="xs"
													color="red"
													variant="outline"
													loading={revoking === session.id}
													aria-label={`${t("sessions.revoke")}: ${session.deviceName || session.deviceId}`}
													onClick={() => {
														void handleRevoke(session.id);
													}}
												>
													{t("sessions.revoke")}
												</Button>
											</Group>
										)}
									</Stack>
								</Paper>
							);
						})}
					</Stack>
				)}

				{error !== null && (
					<Alert color="red" title={t(errorTitle)}>
						{error}
					</Alert>
				)}

				<Group justify="space-between">
					<Button
						color="red"
						variant="filled"
						loading={loggingOut}
						onClick={() => {
							void handleLogoutAll();
						}}
					>
						{t("sessions.logoutAll")}
					</Button>
					<Button variant="default" onClick={onClose}>
						{t("sessions.close")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
