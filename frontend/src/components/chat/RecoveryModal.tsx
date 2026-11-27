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
	getIdentityKeyPair,
	hasLocalLock,
	KeyPublishError,
	onRecoveryNeeded,
	restoreKeyPairFromBackup,
	StaleKeyStateError,
} from "../../e2ee/keys.ts";
import {
	hasServerPasskeyBackup,
	isPasskeyUnlockAvailable,
	restoreWithServerPasskey,
} from "../../e2ee/passkeyLock.ts";

const RECOVERY_FAILED_KEY = "backup.recoveryFailed";
const RECOVERY_STALE_KEY = "backup.recoveryStale";

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
	const [passkeyAvailable, setPasskeyAvailable] = useState(false);

	useEffect(() => {
		return onRecoveryNeeded((evtToken) => {
			if (evtToken === activeToken) {
				setPassword("");
				setError(null);
				setToken(evtToken);
				setOpen(true);
				void hasServerPasskeyBackup(evtToken)
					.then(setPasskeyAvailable)
					.catch(() => setPasskeyAvailable(false));
			}
		});
	}, [activeToken]);

	// The dialog is tied to the token that triggered it. A session switch
	// while it is open must not let its actions touch another account.
	useEffect(() => {
		void activeToken;
		setOpen(false);
		setToken(null);
		setPassword("");
		setError(null);
	}, [activeToken]);

	async function handleRecover() {
		if (token === null || token !== activeToken || password === "") return;
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
					: err instanceof StaleKeyStateError
						? t(RECOVERY_STALE_KEY)
						: t(RECOVERY_FAILED_KEY),
			);
		} finally {
			setLoading(false);
			setWorking(null);
		}
	}

	async function handlePasskeyRecover() {
		if (token === null || token !== activeToken) return;
		setLoading(true);
		setWorking("recover");
		setError(null);
		try {
			await restoreWithServerPasskey(token);
			window.location.reload();
		} catch (err) {
			setError(
				err instanceof StaleKeyStateError
					? t(RECOVERY_STALE_KEY)
					: t(RECOVERY_FAILED_KEY),
			);
		} finally {
			setLoading(false);
			setWorking(null);
		}
	}

	async function handleDecline() {
		if (token === null || token !== activeToken) return;
		setLoading(true);
		setWorking("decline");
		setError(null);
		try {
			const locked = await hasLocalLock();
			const identity = await getIdentityKeyPair();
			const warning = locked
				? t("backup.recoveryDeclineLock")
				: identity === null
					? t("backup.recoveryDeclineIdentity")
					: t("backup.recoveryDeclineConfirm");
			if (!window.confirm(warning)) {
				return;
			}
			await discardRecoveryAndGenerate(token, {
				resetLocalLock: locked,
				allowIdentityRollback: true,
			});
			window.location.reload();
		} catch (err) {
			// The new key is already local; a failed upload is retried by
			// ensureAccountKeys on the next load, so do not ask the user to
			// discard again (that would rotate once more).
			if (err instanceof KeyPublishError) {
				window.location.reload();
				return;
			}
			const code =
				typeof err === "object" && err !== null && "code" in err
					? (err as { code?: unknown }).code
					: undefined;
			setError(
				code === "stale-key-backup"
					? t(RECOVERY_STALE_KEY)
					: t(RECOVERY_FAILED_KEY),
			);
		} finally {
			setLoading(false);
			setWorking(null);
		}
	}

	if (!open || token === null) return null;

	return (
		<Modal
			opened={open}
			onClose={() => {}}
			title={t("backup.recoveryTitle")}
			size="sm"
			closeOnEscape={false}
			withCloseButton={false}
			closeOnClickOutside={false}
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

				{passkeyAvailable && isPasskeyUnlockAvailable() && (
					<Button
						variant="light"
						loading={working === "recover"}
						onClick={() => void handlePasskeyRecover()}
					>
						{t("backup.recoverPasskey")}
					</Button>
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
					{error !== null && (
						<Button
							variant="subtle"
							onClick={() => {
								setOpen(false);
							}}
						>
							{t("backup.close")}
						</Button>
					)}
				</div>
			</Stack>
		</Modal>
	);
}
