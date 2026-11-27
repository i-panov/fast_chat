import {
	Alert,
	Button,
	Group,
	PasswordInput,
	Stack,
	Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { E2EBackupError } from "../../e2ee/backup.ts";
import {
	hasLocalLock,
	KeyBackupSaveError,
	KeyPublishError,
	LocalLockEnabledError,
	onServerBackupChanged,
	PasskeyBackupEnabledError,
	rotateEncryptionKey,
	rotateSigningKey,
	StaleKeyStateError,
} from "../../e2ee/keys.ts";
import { onLocalLockChanged } from "../../e2ee/localLock.ts";
import { hasServerPasskeyBackup } from "../../e2ee/passkeyLock.ts";

// KeyRotationSettings performs the two independent rotations. The backup
// password is required because the new version must be recoverable.
export function KeyRotationSettings({ token }: { token: string }) {
	const { t } = useTranslation();
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState<"encryption" | "signing" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);
	// Unknown is a real state: the buttons must stay disabled until the
	// server backup shape is known, otherwise a passkey-protected backup
	// makes the first click fail with PasskeyBackupEnabledError.
	const [serverPasskey, setServerPasskey] = useState<boolean | null>(null);
	const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);

	useEffect(() => {
		let cancelled = false;
		const refresh = () => {
			void Promise.all([
				hasServerPasskeyBackup(token).catch(() => null),
				hasLocalLock().catch(() => null),
			]).then(([passkey, lock]) => {
				if (cancelled) return;
				setServerPasskey(passkey);
				setLockEnabled(lock);
			});
		};
		refresh();
		const off = onLocalLockChanged(refresh);
		const offBackup = onServerBackupChanged(refresh);
		return () => {
			cancelled = true;
			off();
			offBackup();
		};
	}, [token]);

	function mapError(err: unknown): string {
		if (err instanceof LocalLockEnabledError)
			return t("rotation.error.lockActive");
		if (err instanceof PasskeyBackupEnabledError) {
			return t("rotation.error.passkeyBackup");
		}
		if (err instanceof E2EBackupError) return t("rotation.error.badPassword");
		const code =
			typeof err === "object" && err !== null && "code" in err
				? (err as { code?: unknown }).code
				: undefined;
		if (code === "stale-key-backup" || code === "stale-master-key") {
			return t("rotation.error.stale");
		}
		if (err instanceof StaleKeyStateError) return t("rotation.error.stale");
		if (err instanceof KeyPublishError) return t("rotation.error.publish");
		if (err instanceof KeyBackupSaveError) {
			return t("rotation.error.backupNotSaved");
		}
		return t("rotation.error.failed");
	}

	async function rotate(kind: "encryption" | "signing") {
		if (password === "" || busy !== null) return;
		setBusy(kind);
		setError(null);
		setDone(null);
		try {
			if (kind === "encryption") await rotateEncryptionKey(token, password);
			else await rotateSigningKey(token, password);
			setDone(
				t(
					kind === "encryption"
						? "rotation.encryptionDone"
						: "rotation.signingDone",
				),
			);
			setPassword("");
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(null);
		}
	}

	return (
		<Stack gap="xs">
			<Text size="sm" fw={500}>
				{t("rotation.title")}
			</Text>
			<Text size="xs" c="dimmed">
				{t("rotation.hint")}
			</Text>
			{lockEnabled === true && (
				<Alert color="orange" py={6}>
					{t("rotation.error.lockActive")}
				</Alert>
			)}
			{serverPasskey === true && (
				<Alert color="orange" py={6}>
					{t("rotation.passkeyHint")}
				</Alert>
			)}
			<PasswordInput
				label={t("backup.password")}
				name="rotation-password"
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.currentTarget.value)}
				disabled={busy !== null}
			/>
			<Group grow>
				<Button
					size="xs"
					variant="light"
					loading={busy === "encryption"}
					disabled={
						password === "" || serverPasskey !== false || lockEnabled !== false
					}
					onClick={() => void rotate("encryption")}
				>
					{t("rotation.encryption")}
				</Button>
				<Button
					size="xs"
					variant="light"
					color="orange"
					loading={busy === "signing"}
					disabled={
						password === "" || serverPasskey !== false || lockEnabled !== false
					}
					onClick={() => void rotate("signing")}
				>
					{t("rotation.signing")}
				</Button>
			</Group>
			<Text size="xs" c="dimmed">
				{t("rotation.signingWarning")}
			</Text>
			{error !== null && (
				<Alert color="red" py={6}>
					{error}
				</Alert>
			)}
			{done !== null && (
				<Alert color="green" py={6}>
					{done}
				</Alert>
			)}
		</Stack>
	);
}
