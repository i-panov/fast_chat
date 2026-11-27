import {
	Alert,
	Button,
	Group,
	Select,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type BackupState,
	getServerBackupState,
	hasPinLock,
	hasWebLocks,
	LocalLockRequiredError,
	notifyServerBackupChanged,
	onServerBackupChanged,
} from "../../e2ee/keys.ts";
import {
	disableLocalPin,
	enableLocalPin,
	isWeakLocalPin,
	LOCAL_PIN_PATTERN,
	LocalLockThrottledError,
	onLocalLockChanged,
	WeakLocalPinError,
} from "../../e2ee/localLock.ts";
import {
	DEFAULT_LOCK_SETTINGS,
	getLocalLockSettings,
	type LocalLockSettings,
	setLocalLockSettings,
} from "../../e2ee/localLockSettings.ts";
import {
	disablePasskey,
	disableServerPasskey,
	enablePasskey,
	enableServerPasskey,
	hasPasskeyLock,
	hasServerPasskeyBackup,
	isPasskeyUnlockAvailable,
	PasskeyPrfMissingError,
	PasskeyPrfUnstableError,
	PasskeyPrfUnsupportedError,
} from "../../e2ee/passkeyLock.ts";

// LocalPinSettings stores the local master-key wrapper. The server backup
// password is separate and is not changed here.
// eslint-disable-next-line max-lines-per-function -- PIN, passkey and schedule settings are one security panel.
export function LocalPinSettings({ token }: { token: string }) {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(false);
	const [passkeyEnabled, setPasskeyEnabled] = useState(false);
	const [serverPasskey, setServerPasskey] = useState(false);
	const [backupState, setBackupState] = useState<BackupState | "loading">(
		"loading",
	);
	const [pin, setPin] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [lockSettings, setLockSettings] = useState<LocalLockSettings>(
		DEFAULT_LOCK_SETTINGS,
	);

	useEffect(() => {
		let cancelled = false;
		void getLocalLockSettings()
			.then((value) => {
				if (!cancelled) setLockSettings(value);
			})
			.catch(() => {});
		const refresh = () => {
			void Promise.all([
				hasPinLock(),
				hasPasskeyLock(),
				hasServerPasskeyBackup(token).catch(() => false),
				getServerBackupState(token).catch(() => "unknown" as const),
			])
				.then(([value, passkey, server, backup]) => {
					if (cancelled) return;
					setEnabled(value);
					setPasskeyEnabled(passkey);
					setServerPasskey(server);
					setBackupState(backup);
				})
				.catch(() => {});
		};
		refresh();
		const off = onLocalLockChanged(refresh);
		// Saving/deleting the backup in the same dialog must reveal or hide
		// the passkey-protection button without reopening the modal.
		const offBackup = onServerBackupChanged(refresh);
		return () => {
			cancelled = true;
			off();
			offBackup();
		};
	}, [token]);

	// A local lock without a usable server backup means a forgotten PIN or a
	// lost authenticator destroys the history for good.
	const backupReady = backupState === "backup" || backupState === "local-stale";
	const canProtectWithLock = backupReady;
	const weakPin = pin !== "" && isWeakLocalPin(pin);
	const canEnable =
		LOCAL_PIN_PATTERN.test(pin) &&
		pin === confirm &&
		!isWeakLocalPin(pin) &&
		canProtectWithLock;

	function mapError(err: unknown): string {
		if (err instanceof LocalLockRequiredError)
			return t("localLock.error.locked");
		if (err instanceof LocalLockThrottledError)
			return t("localLock.error.throttled", {
				seconds: err.retryAfterSeconds,
			});
		if (err instanceof WeakLocalPinError) return t("localLock.error.weakPin");
		if (err instanceof PasskeyPrfUnsupportedError) {
			return t("localLock.error.prfUnsupported");
		}
		if (err instanceof PasskeyPrfMissingError) {
			return t("localLock.error.prfMissing");
		}
		if (err instanceof PasskeyPrfUnstableError) {
			return t("localLock.error.prfUnstable");
		}
		if (
			err instanceof Error &&
			(err.message === "no local keys to protect" ||
				err.message === "local key lock is closed")
		) {
			return t("localLock.error.locked");
		}
		if (err instanceof DOMException && err.name === "NotAllowedError") {
			return t("localLock.error.cancelled");
		}
		if (
			err instanceof Error &&
			err.message.includes("passkeys are not available")
		) {
			return t("localLock.error.passkeyUnavailable");
		}
		if (
			err instanceof Error &&
			err.message.includes("set the backup password first")
		) {
			return t("localLock.error.backupPasswordFirst");
		}
		return t("localLock.error.failed");
	}

	function updateLockSettings(patch: Partial<LocalLockSettings>) {
		const previous = lockSettings;
		const next = { ...previous, ...patch };
		setLockSettings(next);
		void setLocalLockSettings(next).catch(() => {
			setLockSettings(previous);
			setError(t("localLock.error.failed"));
		});
	}

	async function handleEnable() {
		if (!canEnable || busy) return;
		setBusy(true);
		setError(null);
		try {
			await enableLocalPin(pin);
			setPin("");
			setConfirm("");
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	async function handlePasskeyEnable() {
		if (busy) return;
		if (!canProtectWithLock) {
			setError(t("localLock.needBackup"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await enablePasskey();
		} catch (err) {
			console.error("enablePasskey failed", err);
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleServerPasskey() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await enableServerPasskey(token);
			setServerPasskey(true);
			notifyServerBackupChanged();
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleServerPasskeyDisable() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await disableServerPasskey(token);
			setServerPasskey(false);
			notifyServerBackupChanged();
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	async function handlePasskeyDisable() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await disablePasskey();
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	async function handleDisable() {
		if (busy) return;
		// Disabling writes the master key back in plaintext; say so first.
		if (!window.confirm(t("localLock.disableConfirm"))) return;
		setBusy(true);
		setError(null);
		try {
			await disableLocalPin();
		} catch (err) {
			setError(mapError(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Stack gap="xs">
			<Text size="sm" fw={500}>
				{t("localLock.title")}
			</Text>
			{!hasWebLocks() && (
				<Alert color="orange" py={6}>
					{t("localLock.webLocksMissing")}
				</Alert>
			)}
			{enabled ? (
				<>
					<Text size="xs" c="dimmed">
						{t("localLock.enabledHint")}
					</Text>
					<Button
						variant="default"
						size="xs"
						loading={busy}
						onClick={() => void handleDisable()}
					>
						{t("localLock.disable")}
					</Button>
				</>
			) : (
				<>
					<Text size="xs" c="dimmed">
						{t("localLock.hint")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("localLock.pinThreatModel")}
					</Text>
					{backupState === "loading" ? null : backupReady ? null : (
						<Alert color="orange" py={6}>
							{t("localLock.needBackup")}
						</Alert>
					)}
					<Group grow align="end">
						<TextInput
							label={t("localLock.pin")}
							name="local-lock-pin"
							autoComplete="off"
							value={pin}
							inputMode="numeric"
							maxLength={6}
							type="password"
							onChange={(e) =>
								setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))
							}
							disabled={busy}
							error={weakPin ? t("localLock.error.weakPin") : undefined}
						/>
						<TextInput
							label={t("localLock.confirm")}
							name="local-lock-pin-confirm"
							autoComplete="off"
							value={confirm}
							inputMode="numeric"
							maxLength={6}
							type="password"
							onChange={(e) =>
								setConfirm(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))
							}
							disabled={busy}
							error={
								confirm !== "" && confirm !== pin
									? t("localLock.pinMismatch")
									: undefined
							}
						/>
					</Group>
					<Button
						size="xs"
						disabled={!canEnable}
						loading={busy}
						onClick={() => void handleEnable()}
					>
						{t("localLock.enable")}
					</Button>
				</>
			)}
			{(enabled || passkeyEnabled) && (
				<Stack gap={6}>
					<Select
						label={t("localLock.inactivity")}
						size="xs"
						value={String(lockSettings.inactivityMs ?? "never")}
						onChange={(value) =>
							updateLockSettings({
								inactivityMs: value === "never" ? null : Number(value),
							})
						}
						data={[
							{ value: "60000", label: t("localLock.min1") },
							{ value: "300000", label: t("localLock.min5") },
							{ value: "900000", label: t("localLock.min15") },
							{ value: "1800000", label: t("localLock.min30") },
							{ value: "3600000", label: t("localLock.hour1") },
							{ value: "never", label: t("localLock.never") },
						]}
					/>
					<Select
						label={t("localLock.background")}
						size="xs"
						value={String(lockSettings.backgroundMs ?? "never")}
						onChange={(value) =>
							updateLockSettings({
								backgroundMs: value === "never" ? null : Number(value),
							})
						}
						data={[
							{ value: "0", label: t("localLock.immediately") },
							{ value: "60000", label: t("localLock.min1") },
							{ value: "300000", label: t("localLock.min5") },
							{ value: "900000", label: t("localLock.min15") },
							{ value: "never", label: t("localLock.never") },
						]}
					/>
					<Switch
						size="xs"
						label={t("localLock.onFreeze")}
						checked={lockSettings.lockOnFreeze}
						onChange={(e) =>
							updateLockSettings({ lockOnFreeze: e.currentTarget.checked })
						}
					/>
					<Switch
						size="xs"
						label={t("localLock.afterSleep")}
						checked={lockSettings.lockAfterSleep}
						onChange={(e) =>
							updateLockSettings({ lockAfterSleep: e.currentTarget.checked })
						}
					/>
				</Stack>
			)}
			{error !== null && (
				<Alert color="red" py={6}>
					{error}
				</Alert>
			)}
			{isPasskeyUnlockAvailable() && !serverPasskey && backupReady && (
				<Button
					variant="light"
					size="xs"
					loading={busy}
					onClick={() => void handleServerPasskey()}
				>
					{t("localLock.serverPasskeyEnable")}
				</Button>
			)}
			{serverPasskey && (
				<Stack gap={6}>
					<Text size="xs" c="green">
						{t("localLock.serverPasskeyEnabled")}
					</Text>
					<Button
						variant="default"
						size="xs"
						loading={busy}
						onClick={() => void handleServerPasskeyDisable()}
					>
						{t("localLock.serverPasskeyDisable")}
					</Button>
				</Stack>
			)}
			{isPasskeyUnlockAvailable() && (
				<Button
					variant={passkeyEnabled ? "default" : "light"}
					size="xs"
					loading={busy}
					disabled={!passkeyEnabled && !canProtectWithLock}
					onClick={() =>
						void (passkeyEnabled
							? handlePasskeyDisable()
							: handlePasskeyEnable())
					}
				>
					{t(
						passkeyEnabled
							? "localLock.passkeyDisable"
							: "localLock.passkeyEnable",
					)}
				</Button>
			)}
			{isPasskeyUnlockAvailable() && !passkeyEnabled && (
				<Text size="xs" c="dimmed">
					{t("localLock.passkeyTwoPrompts")}
				</Text>
			)}
		</Stack>
	);
}
