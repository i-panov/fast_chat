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
	checkIdentityForDiscard,
	discardRecoveryAndGenerate,
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

// eslint-disable-next-line max-lines-per-function -- recovery, passkey and the destructive "start fresh" path share one decision surface.
export function RecoveryModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [token, setToken] = useState<string | null>(null);
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [working, setWorking] = useState<"recover" | "decline" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [passkeyAvailable, setPasskeyAvailable] = useState(false);
	const [lockEnabled, setLockEnabled] = useState(false);

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
				void hasLocalLock()
					.then(setLockEnabled)
					.catch(() => setLockEnabled(false));
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

	// Restoring a server backup drops the local PIN/passkey wrapper: the
	// restored key no longer matches it. That is unavoidable, but it must be
	// acknowledged instead of happening silently. Re-check the lock here
	// rather than trusting the state captured when the dialog opened.
	async function confirmLockRemoval(): Promise<boolean> {
		if (!(await hasLocalLock())) return true;
		return window.confirm(t("backup.recoveryRemovesLock"));
	}

	async function handleRecover() {
		if (loading) return;
		if (token === null || token !== activeToken || password === "") return;
		setLoading(true);
		setWorking("recover");
		setError(null);
		try {
			if (!(await confirmLockRemoval())) return;
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
		if (loading) return;
		if (token === null || token !== activeToken) return;
		setLoading(true);
		setWorking("recover");
		setError(null);
		try {
			if (!(await confirmLockRemoval())) return;
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
		if (loading) return;
		if (token === null || token !== activeToken) return;
		setLoading(true);
		setWorking("decline");
		setError(null);
		try {
			const locked = await hasLocalLock();
			// Replacing an identity the server still publishes makes contacts
			// reject this account; that case needs the explicit warning too,
			// not only a missing local identity.
			const identityCheck = await checkIdentityForDiscard(token);
			const warning = locked
				? t("backup.recoveryDeclineLock")
				: identityCheck !== "ok"
					? t("backup.recoveryDeclineIdentity")
					: t("backup.recoveryDeclineConfirm");
			if (!window.confirm(warning)) {
				return;
			}
			await discardRecoveryAndGenerate(token, {
				resetLocalLock: locked,
				allowIdentityRollback: identityCheck !== "ok",
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

				{lockEnabled && (
					<Alert color="orange" py={6}>
						{t("backup.recoveryRemovesLock")}
					</Alert>
				)}

				<PasswordInput
					label={t("backup.password")}
					name="recovery-password"
					autoComplete="current-password"
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
						variant="subtle"
						disabled={loading}
						onClick={() => setOpen(false)}
					>
						{t("backup.recoveryLater")}
					</Button>
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
						disabled={password === "" || loading}
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
