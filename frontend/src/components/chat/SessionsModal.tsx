import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getSessions, revokeDeviceSession } from "../../api.ts";
import type { SessionInfo } from "../../types/api.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
	onLogoutAll: () => void;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function SessionsModal({ open, onClose, token, onLogoutAll }: Props) {
	const { t } = useTranslation();
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [loading, setLoading] = useState(false);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || token === undefined) return;

		let cancelled = false;
		setLoading(true);
		setError(null);
		void getSessions(token)
			.then((result) => {
				if (!cancelled) setSessions(result.sessions);
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [open, token]);

	async function handleRevoke(sessionID: string) {
		if (token === undefined) return;
		setRevoking(sessionID);
		setError(null);
		try {
			await revokeDeviceSession(token, sessionID);
			setSessions((prev) => prev.filter((s) => s.id !== sessionID));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(null);
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("sessions.title")}
			size="md"
			centered
		>
			<Stack gap="md">
				<Text size="xs" c="dimmed">
					{t("sessions.hint")}
				</Text>

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
						{sessions.map((session) => (
							<Group
								key={session.id}
								justify="space-between"
								wrap="nowrap"
								style={{
									padding: "8px 12px",
									border: "1px solid var(--mantine-color-dark-4)",
									borderRadius: 4,
								}}
							>
								<div style={{ minWidth: 0 }}>
									<Group gap={6} wrap="nowrap">
										<Text size="sm" fw={500} truncate>
											{session.deviceName || session.deviceId}
										</Text>
										{session.current && (
											<Badge size="xs" variant="light">
												{t("sessions.thisDevice")}
											</Badge>
										)}
									</Group>
									<Text size="xs" c="dimmed">
										{t("sessions.lastSeen", {
											when: formatDate(session.lastSeenAt),
										})}
									</Text>
								</div>
								{!session.current && (
									<Button
										size="xs"
										color="red"
										variant="outline"
										loading={revoking === session.id}
										onClick={() => {
											void handleRevoke(session.id);
										}}
									>
										{t("sessions.revoke")}
									</Button>
								)}
							</Group>
						))}
					</Stack>
				)}

				{error !== null && (
					<Alert color="red" title={t("sessions.errorTitle")}>
						{error}
					</Alert>
				)}

				<Group justify="space-between">
					<Button
						color="red"
						variant="filled"
						onClick={() => {
							onLogoutAll();
							onClose();
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
