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
import { E2EBackupError } from "../../e2ee/backup.ts";
import {
	discardRecoveryAndGenerate,
	onRecoveryNeeded,
	restoreKeyPairFromBackup,
} from "../../e2ee/keys.ts";

interface Props {
	activeToken: string | null;
}

export function RecoveryModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [working, setWorking] = useState<"recover" | "decline" | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		return onRecoveryNeeded((evtToken) => {
			if (evtToken === activeToken) {
				setPassword("");
				setError(null);
				setToken(evtToken);
				setOpen(true);
			}
		});
	}, [activeToken]);

	async function handleRecover() {
		if (token === null || password === "") return;
		setLoading(true);
		setWorking("recover");
		setError(null);
		try {
			await restoreKeyPairFromBackup(token, password);
			window.location.reload();
		} catch (err) {
			setError(
				err instanceof E2EBackupError
					? t("backup.recoveryWrongPassword")
					: t("backup.recoveryFailed"),
			);
		} finally {
			setLoading(false);
			setWorking(null);
		}
	}

	async function handleDecline() {
		if (token === null) return;
		setLoading(true);
		setWorking("decline");
		setError(null);
		try {
			await discardRecoveryAndGenerate(token);
			window.location.reload();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
			setWorking(null);
		}
	}

	if (!open || token === null) return null;

	return (
		<Modal
			opened={open}
			onClose={() => setOpen(false)}
			title={t("backup.recoveryTitle")}
			size="sm"
		>
			<Stack gap="md">
				<Alert color="red" title={t("backup.recoveryWarningTitle")}>
					<Text size="sm">{t("backup.recoveryPrompt")}</Text>
					<Text size="sm" mt="xs">
						{t("backup.warningNoRecovery")}
					</Text>
				</Alert>

				<PasswordInput
					label={t("backup.password")}
					value={password}
					onChange={(e) => setPassword(e.currentTarget.value)}
					disabled={loading}
					autoFocus
					onKeyDown={(e) => {
						if (e.key === "Enter" && password !== "") {
							void handleRecover();
						}
					}}
				/>

				{error !== null && (
					<Text size="sm" c="red">
						{error}
					</Text>
				)}

				<div
					style={{ display: "flex", justifyContent: "flex-end", gap: "8px" }}
				>
					<Button
						variant="default"
						loading={working === "decline"}
						disabled={loading}
						onClick={() => {
							void handleDecline();
						}}
					>
						{t("backup.recoveryDecline")}
					</Button>
					<Button
						loading={working === "recover"}
						disabled={password === ""}
						onClick={() => {
							void handleRecover();
						}}
					>
						{t("backup.recoveryRecover")}
					</Button>
				</div>
			</Stack>
		</Modal>
	);
}
