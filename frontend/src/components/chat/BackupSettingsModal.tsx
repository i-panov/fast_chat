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
	hasServerKeyBackup,
	uploadKeyBackup,
} from "../../e2ee/keys.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string;
	keyPair: KeyPair | null;
}

export function BackupSettingsModal({ open, onClose, token, keyPair }: Props) {
	const { t } = useTranslation();
	const [exists, setExists] = useState(false);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setExists(false);
		setError(null);
		setDone(false);
		hasServerKeyBackup(token)
			.then((has) => {
				if (!cancelled) setExists(has);
			})
			.catch(() => {
				if (!cancelled) setExists(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token]);

	const canSave = password.length >= 8 && password === confirm;

	async function handleSave() {
		if (!canSave || keyPair === null) return;
		setSaving(true);
		setError(null);
		try {
			await uploadKeyBackup(token, password, keyPair);
			setExists(true);
			setDone(true);
			setPassword("");
			setConfirm("");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
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
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	}

	const hasLocalKey = keyPair !== null;

	return (
		<Modal opened={open} onClose={onClose} title={t("backup.title")} size="sm">
			<Stack gap="md">
				{done ? (
					<Alert color="green" title={t("backup.doneTitle")}>
						{exists ? t("backup.doneEnabled") : t("backup.doneDisabled")}
					</Alert>
				) : (
					<>
						<Alert color="red" title={t("backup.warningTitle")}>
							<Text size="sm">{t("backup.warningMessage")}</Text>
							<Text size="sm" mt="xs">
								{t("backup.warningNoRecovery")}
							</Text>
						</Alert>

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
							<Text size="sm" c="red">
								{error}
							</Text>
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
					</>
				)}
				{done && <Button onClick={onClose}>{t("backup.close")}</Button>}
			</Stack>
		</Modal>
	);
}
