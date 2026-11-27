import {
	Alert,
	Button,
	Modal,
	PasswordInput,
	Stack,
	Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyPair } from "../../e2ee/crypto.ts";
import {
	clearServerKeyBackup,
	getServerBackupState,
	requestRecoveryAfterForgotPin,
	StaleKeyStateError,
	uploadKeyBackup,
} from "../../e2ee/keys.ts";
import { KeyRotationSettings } from "./KeyRotationSettings.tsx";
import { LocalPinSettings } from "./LocalPinSettings.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string;
	keyPair: KeyPair | null;
	required?: boolean;
}

// eslint-disable-next-line max-lines-per-function -- backup, PIN/passkey and rotation controls share one dialog.
export function BackupSettingsModal({
	open,
	onClose,
	token,
	keyPair,
	required = false,
}: Props) {
	const { t } = useTranslation();
	const [exists, setExists] = useState(false);
	const [stale, setStale] = useState(false);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);
	const [canRecover, setCanRecover] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setExists(false);
		setStale(false);
		setError(null);
		setDone(false);
		setSaveFailed(false);
		setCanRecover(false);
		setPassword("");
		setConfirm("");
		getServerBackupState(token)
			.then((state) => {
				if (cancelled) return;
				setExists(state === "backup");
				setStale(
					state === "legacy" || state === "stale" || state === "local-stale",
				);
			})
			.catch(() => {
				if (!cancelled) setExists(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token]);

	const canSave = password.length >= 8 && password === confirm;

	function isStaleError(err: unknown): boolean {
		const code =
			typeof err === "object" && err !== null && "code" in err
				? (err as { code?: unknown }).code
				: undefined;
		return (
			err instanceof StaleKeyStateError ||
			code === "stale-key-backup" ||
			code === "stale-master-key"
		);
	}

	function backupErrorText(err: unknown): string {
		return isStaleError(err) ? t("backup.staleKey") : t("backup.saveFailed");
	}

	async function handleSave() {
		if (!canSave || keyPair === null) return;
		setSaving(true);
		setError(null);
		try {
			await uploadKeyBackup(token, password);
			setExists(true);
			setStale(false);
			setDone(true);
			setPassword("");
			setConfirm("");
		} catch (err) {
			setSaveFailed(true);
			setCanRecover(isStaleError(err));
			setError(backupErrorText(err));
		} finally {
			setSaving(false);
		}
	}

	async function handleDelete() {
		setSaving(true);
		setError(null);
		try {
			await clearServerKeyBackup(token);
			setExists(false);
			setDone(true);
		} catch (err) {
			setCanRecover(isStaleError(err));
			setError(backupErrorText(err));
		} finally {
			setSaving(false);
		}
	}

	const hasLocalKey = keyPair !== null;

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("backup.title")}
			size="sm"
			withCloseButton={!required}
			closeOnClickOutside={!required}
			closeOnEscape={!required}
		>
			<Stack gap="md">
				{done ? (
					<Alert color="green" title={t("backup.doneTitle")}>
						{exists ? t("backup.doneEnabled") : t("backup.doneDisabled")}
					</Alert>
				) : (
					<>
						{exists ? (
							<Alert color="blue" title={t("backup.enabledTitle")}>
								<Text size="sm">{t("backup.enabledHint")}</Text>
							</Alert>
						) : stale ? (
							<Alert color="orange" title={t("backup.staleTitle")}>
								<Text size="sm">{t("backup.staleHint")}</Text>
							</Alert>
						) : (
							<Alert color="red" title={t("backup.warningTitle")}>
								<Text size="sm">{t("backup.warningMessage")}</Text>
								<Text size="sm" mt="xs">
									{t("backup.warningNoRecovery")}
								</Text>
							</Alert>
						)}

						{!hasLocalKey && (
							<Text size="sm" c="dimmed">
								{t("backup.needLocalKey")}
							</Text>
						)}

						<PasswordInput
							label={t("backup.password")}
							value={password}
							onChange={(e) => setPassword(e.currentTarget.value)}
							disabled={!hasLocalKey || saving}
						/>
						<PasswordInput
							label={t("backup.confirm")}
							value={confirm}
							onChange={(e) => setConfirm(e.currentTarget.value)}
							disabled={!hasLocalKey || saving}
						/>

						{error !== null && (
							<Stack gap={6}>
								<Text size="sm" c="red">
									{error}
								</Text>
								{canRecover && (
									<Button
										variant="light"
										size="xs"
										onClick={() => {
											requestRecoveryAfterForgotPin(token);
											onClose();
										}}
									>
										{t("backup.recoveryRecover")}
									</Button>
								)}
							</Stack>
						)}

						<div
							style={{
								display: "flex",
								justifyContent: "flex-end",
								gap: "8px",
							}}
						>
							{exists && (
								<Button
									variant="outline"
									color="red"
									loading={saving}
									disabled={!hasLocalKey}
									onClick={() => {
										if (!window.confirm(t("backup.deleteConfirm"))) return;
										void handleDelete();
									}}
								>
									{t("backup.delete")}
								</Button>
							)}
							<Button
								loading={saving}
								disabled={!canSave || !hasLocalKey}
								onClick={() => {
									void handleSave();
								}}
							>
								{exists ? t("backup.change") : t("backup.save")}
							</Button>
						</div>
						{required && saveFailed && (
							<Button variant="subtle" size="xs" onClick={onClose}>
								{t("backup.continueWithout")}
							</Button>
						)}
					</>
				)}
				{!required && (
					<>
						<LocalPinSettings token={token} />
						<KeyRotationSettings token={token} />
					</>
				)}
				{done && <Button onClick={onClose}>{t("backup.close")}</Button>}
			</Stack>
		</Modal>
	);
}
