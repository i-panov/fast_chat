import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Modal,
	PasswordInput,
	Stack,
	Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	getSessions,
	getUserDeviceKeys,
	revokeDeviceSession,
	revokeUserDeviceKey,
} from "../../api.ts";
import { restoreKeyPairFromDeviceBackup } from "../../e2ee/keys.ts";
import type { SessionInfo } from "../../types/api.ts";

const RESTORE_KEY_LABEL = "sessions.restoreKey";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
	userId: string;
	onLogoutAll: () => void;
}

function formatDate(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

// The dialog bundles sessions, key state and per-device backup actions.
// eslint-disable-next-line max-lines-per-function
export function SessionsModal({
	open,
	onClose,
	token,
	userId,
	onLogoutAll,
}: Props) {
	const { t } = useTranslation();
	const [sessions, setSessions] = useState<SessionInfo[]>([]);
	const [deviceKeys, setDeviceKeys] = useState<Map<string, boolean>>(new Map());
	const [restoreTarget, setRestoreTarget] = useState<SessionInfo | null>(null);
	const [restorePassword, setRestorePassword] = useState("");
	const [restoreError, setRestoreError] = useState<string | null>(null);
	const [restoring, setRestoring] = useState(false);
	const [loading, setLoading] = useState(false);
	const [revoking, setRevoking] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || token === undefined) return;

		let cancelled = false;
		setLoading(true);
		setError(null);
		void Promise.all([getSessions(token), getUserDeviceKeys(token, userId)])
			.then(([result, keys]) => {
				if (!cancelled) {
					setSessions(result.sessions);
					setDeviceKeys(
						new Map(
							keys.devices.map((device) => [
								device.id,
								device.hasBackup === true,
							]),
						),
					);
				}
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
	}, [open, token, userId]);

	async function handleRevokeKey(deviceID: string) {
		if (token === undefined) return;
		setRevoking(deviceID);
		setError(null);
		try {
			await revokeUserDeviceKey(token, deviceID);
			setDeviceKeys((prev) => {
				const next = new Map(prev);
				next.delete(deviceID);
				return next;
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setRevoking(null);
		}
	}

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
		<>
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
											{deviceKeys.get(session.id) === true && (
												<Button
													size="xs"
													color="blue"
													variant="subtle"
													onClick={() => {
														setRestorePassword("");
														setRestoreError(null);
														setRestoreTarget(session);
													}}
												>
													{t(RESTORE_KEY_LABEL)}
												</Button>
											)}
											{deviceKeys.has(session.id) && (
												<Badge size="xs" variant="outline" color="teal">
													{t("sessions.key")}
												</Badge>
											)}
											{deviceKeys.get(session.id) === true && (
												<Badge size="xs" variant="outline" color="blue">
													{t("sessions.keyBackup")}
												</Badge>
											)}
										</Group>
										<Text size="xs" c="dimmed">
											{t("sessions.lastSeen", {
												when: formatDate(session.lastSeenAt),
											})}
										</Text>
									</div>
									{deviceKeys.get(session.id) === true && (
										<Button
											size="xs"
											color="blue"
											variant="subtle"
											onClick={() => {
												setRestorePassword("");
												setRestoreError(null);
												setRestoreTarget(session);
											}}
										>
											{t(RESTORE_KEY_LABEL)}
										</Button>
									)}
									{deviceKeys.has(session.id) && (
										<Button
											size="xs"
											color="orange"
											variant="subtle"
											loading={revoking === session.id}
											onClick={() => {
												void handleRevokeKey(session.id);
											}}
										>
											{t("sessions.revokeKey")}
										</Button>
									)}
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
			<Modal
				opened={restoreTarget !== null}
				onClose={() => setRestoreTarget(null)}
				title={t("sessions.restoreKeyTitle")}
				size="sm"
				centered
			>
				<Stack gap="md">
					<Text size="sm">
						{t("sessions.restoreKeyHint", {
							device: restoreTarget?.deviceName ?? "",
						})}
					</Text>
					<PasswordInput
						label={t("backup.password")}
						value={restorePassword}
						onChange={(event) => setRestorePassword(event.currentTarget.value)}
						autoFocus
					/>
					{restoreError !== null && (
						<Alert color="red" title={t("sessions.restoreKeyFailed")}>
							{restoreError}
						</Alert>
					)}
					<Group justify="flex-end">
						<Button variant="default" onClick={() => setRestoreTarget(null)}>
							{t("sessions.close")}
						</Button>
						<Button
							loading={restoring}
							disabled={restorePassword === "" || token === undefined}
							onClick={() => {
								if (restoreTarget === null || token === undefined) return;
								setRestoring(true);
								setRestoreError(null);
								void restoreKeyPairFromDeviceBackup(
									token,
									restoreTarget.id,
									restorePassword,
								)
									.then(() => window.location.reload())
									.catch((err: unknown) => {
										setRestoreError(
											err instanceof Error ? err.message : String(err),
										);
									})
									.finally(() => setRestoring(false));
							}}
						>
							{t(RESTORE_KEY_LABEL)}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
