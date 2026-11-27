import { Alert, Button, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { E2EBackupError } from "../../e2ee/backup.ts";
import {
	getAccountScope,
	getServerBackupState,
	hasLocalLock,
	hasPinLock,
	invalidateKeyMaterialCaches,
	isLocalLockUnlocked,
	KEY_MATERIAL_CHANNEL,
	KEY_TAB_ID,
	lockLocalKeys,
	requestRecoveryAfterForgotPin,
} from "../../e2ee/keys.ts";
import {
	clearLocalLockAndKeys,
	onLocalLockChanged,
	unlockLocalPin,
} from "../../e2ee/localLock.ts";
import {
	DEFAULT_LOCK_SETTINGS,
	getLocalLockSettings,
	type LocalLockSettings,
	onLocalLockSettingsChanged,
} from "../../e2ee/localLockSettings.ts";
import {
	hasPasskeyLock,
	hasServerPasskeyBackup,
	unlockWithPasskey,
} from "../../e2ee/passkeyLock.ts";
import { clearDecryptedFileCache } from "../../utils/fileCache.ts";

// LocalLockModal keeps the master key out of the running session until the
// user enters the PIN. Auto-lock clears the in-memory copy again.
// eslint-disable-next-line max-lines-per-function -- PIN/passkey, timers and lifecycle handlers share one lock surface.
export function LocalLockModal({
	activeToken,
}: {
	activeToken: string | null;
}) {
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState(false);
	const [pinEnabled, setPinEnabled] = useState(false);
	const [passkeyEnabled, setPasskeyEnabled] = useState(false);
	const [locked, setLocked] = useState(false);
	const [pin, setPin] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [lockSettings, setLockSettings] = useState<LocalLockSettings>(
		DEFAULT_LOCK_SETTINGS,
	);
	const lockTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const backgroundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lockChannel = useRef<BroadcastChannel | null>(null);

	useEffect(() => {
		if (activeToken === null) {
			setEnabled(false);
			setLocked(false);
			return;
		}
		let cancelled = false;
		const refresh = () => {
			void Promise.all([hasLocalLock(), hasPinLock(), hasPasskeyLock()])
				.then(([value, pin, passkey]) => {
					if (cancelled) return;
					setEnabled(value);
					setPinEnabled(pin);
					setPasskeyEnabled(passkey);
					setLocked(value && !isLocalLockUnlocked());
				})
				.catch(() => {});
		};
		refresh();
		const off = onLocalLockChanged(refresh);
		return () => {
			cancelled = true;
			off();
		};
	}, [activeToken]);

	// A cold start with a closed lock must also drop plaintext attachments
	// left in IndexedDB by a previous session.
	useEffect(() => {
		if (enabled && locked) {
			void clearDecryptedFileCache(getAccountScope() || null);
		}
	}, [enabled, locked]);

	// Auto-lock in one tab must also lock the other open tabs of this account.
	useEffect(() => {
		if (typeof BroadcastChannel === "undefined" || activeToken === null) {
			return;
		}
		const channel = new BroadcastChannel("fastchat-local-lock");
		lockChannel.current = channel;
		channel.onmessage = (event: MessageEvent<unknown>) => {
			const data = event.data as {
				type?: string;
				token?: string;
				tabId?: string;
			} | null;
			if (
				data?.type === "lock" &&
				data.token === activeToken &&
				data.tabId !== KEY_TAB_ID
			) {
				lockLocalKeys();
			}
		};
		return () => {
			channel.close();
			lockChannel.current = null;
		};
	}, [activeToken]);

	// Rotation/creation in another tab leaves this tab with a stale in-memory
	// key; drop it so the next read picks up the shared IndexedDB row.
	useEffect(() => {
		if (typeof BroadcastChannel === "undefined" || activeToken === null) {
			return;
		}
		const channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
		channel.onmessage = (event: MessageEvent<unknown>) => {
			const data = event.data as { scope?: string; tabId?: string } | null;
			if (typeof data?.scope === "string" && data.tabId !== KEY_TAB_ID) {
				invalidateKeyMaterialCaches(data.scope);
			}
		};
		return () => channel.close();
	}, [activeToken]);

	useEffect(() => {
		if (activeToken === null) return;
		let cancelled = false;
		const refresh = () => {
			void getLocalLockSettings()
				.then((value) => {
					if (!cancelled) setLockSettings(value);
				})
				.catch(() => {});
		};
		refresh();
		const off = onLocalLockSettingsChanged(refresh);
		return () => {
			cancelled = true;
			off();
		};
	}, [activeToken]);

	useEffect(() => {
		if (!enabled || locked || activeToken === null) return;
		let lastActivity = Date.now();
		let hiddenAt: number | null = null;
		const clearTimers = () => {
			if (lockTimer.current !== null) clearTimeout(lockTimer.current);
			if (backgroundTimer.current !== null)
				clearTimeout(backgroundTimer.current);
		};
		const lock = (notifyTabs = true) => {
			clearTimers();
			lockLocalKeys();
			if (notifyTabs) {
				try {
					lockChannel.current?.postMessage({
						type: "lock",
						token: activeToken,
						tabId: KEY_TAB_ID,
					});
				} catch {
					// BroadcastChannel is best-effort.
				}
			}
			setLocked(true);
		};
		const arm = () => {
			lastActivity = Date.now();
			clearTimers();
			if (lockSettings.inactivityMs !== null) {
				lockTimer.current = setTimeout(lock, lockSettings.inactivityMs);
			}
		};
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				if (lockSettings.backgroundMs === 0) {
					lock();
					return;
				}
				if (lockSettings.backgroundMs !== null) {
					backgroundTimer.current = setTimeout(lock, lockSettings.backgroundMs);
				}
				return;
			}
			if (backgroundTimer.current !== null) {
				clearTimeout(backgroundTimer.current);
				backgroundTimer.current = null;
			}
			// Sleep/screen-lock can be detected here before arm() resets the
			// inactivity clock; otherwise the later focus handler never sees
			// an expired interval.
			if (
				lockSettings.lockAfterSleep &&
				hiddenAt !== null &&
				lockSettings.inactivityMs !== null &&
				Date.now() - hiddenAt >= lockSettings.inactivityMs
			) {
				lock();
				return;
			}
			// Background locking is its own setting: a frozen background timer
			// must not make it depend on the separate sleep toggle.
			const threshold = lockSettings.backgroundMs;
			if (
				hiddenAt !== null &&
				threshold !== null &&
				Date.now() - hiddenAt >= threshold
			) {
				lock();
				return;
			}
			hiddenAt = null;
			arm();
		};
		const onReturn = () => {
			if (
				lockSettings.lockAfterSleep &&
				lockSettings.inactivityMs !== null &&
				Date.now() - lastActivity >= lockSettings.inactivityMs
			) {
				lock();
			}
		};
		const onFreeze = () => {
			// Closing one tab must not lock the other open tabs.
			if (lockSettings.lockOnFreeze) lock(false);
		};
		arm();
		for (const event of ["pointerdown", "keydown"] as const) {
			window.addEventListener(event, arm, { passive: true });
		}
		document.addEventListener("visibilitychange", onVisibility);
		window.addEventListener("focus", onReturn);
		window.addEventListener("pageshow", onReturn);
		window.addEventListener("pagehide", onFreeze);
		document.addEventListener("freeze", onFreeze);
		return () => {
			clearTimers();
			for (const event of ["pointerdown", "keydown"] as const) {
				window.removeEventListener(event, arm);
			}
			document.removeEventListener("visibilitychange", onVisibility);
			window.removeEventListener("focus", onReturn);
			window.removeEventListener("pageshow", onReturn);
			window.removeEventListener("pagehide", onFreeze);
			document.removeEventListener("freeze", onFreeze);
		};
	}, [enabled, locked, activeToken, lockSettings]);

	async function handleUnlock() {
		if (busy || pin.length !== 6) return;
		setBusy(true);
		setError(null);
		try {
			await unlockLocalPin(pin);
			setPin("");
			setLocked(false);
		} catch (err) {
			// A wrong PIN is an E2EBackupError; DB/crypto failures are not.
			setError(
				err instanceof E2EBackupError
					? t("localLock.wrongPin")
					: t("localLock.error.failed"),
			);
		} finally {
			setBusy(false);
		}
	}

	async function handlePasskey() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			await unlockWithPasskey();
			setLocked(false);
		} catch {
			setError(t("localLock.passkeyFailed"));
		} finally {
			setBusy(false);
		}
	}

	async function handleForgot() {
		if (busy) return;
		let recoverable = false;
		let stale = false;
		if (activeToken !== null) {
			const state = await getServerBackupState(activeToken).catch(
				() => "unknown" as const,
			);
			if (state === "unknown") {
				setError(t("localLock.error.backupUnknown"));
				return;
			}
			stale = state === "stale" || state === "legacy";
			recoverable =
				state === "backup" ||
				state === "local-stale" ||
				(await hasServerPasskeyBackup(activeToken).catch(() => false));
		}
		// Removing the local keys is irreversible without a usable server
		// backup, and this button sits next to the PIN field, so it needs an
		// explicit confirmation that matches the actual recovery options.
		const warning = stale
			? t("localLock.forgotStale")
			: recoverable
				? t("localLock.forgotConfirm")
				: t("localLock.forgotNoBackup");
		if (!window.confirm(warning)) {
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await clearLocalLockAndKeys();
			setEnabled(false);
			setLocked(false);
			if (activeToken !== null) requestRecoveryAfterForgotPin(activeToken);
		} catch {
			setError(t("localLock.error.failed"));
		} finally {
			// A partial wipe must still leave the UI matching the stored state.
			const stillEnabled = await hasLocalLock().catch(() => false);
			setEnabled(stillEnabled);
			setLocked(stillEnabled && !isLocalLockUnlocked());
			setBusy(false);
		}
	}

	if (!enabled || !locked) return null;

	return (
		<Modal
			opened
			onClose={() => {}}
			title={t("localLock.lockedTitle")}
			centered
			closeOnClickOutside={false}
			closeOnEscape={false}
			withCloseButton={false}
		>
			<Stack gap="md">
				<Text size="sm">{t("localLock.lockedHint")}</Text>
				{passkeyEnabled && (
					<Button
						variant="light"
						onClick={() => void handlePasskey()}
						loading={busy}
					>
						{t("localLock.unlockPasskey")}
					</Button>
				)}
				{pinEnabled && (
					<TextInput
						label={t("localLock.pin")}
						value={pin}
						inputMode="numeric"
						maxLength={6}
						type="password"
						autoFocus
						onChange={(e) =>
							setPin(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))
						}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleUnlock();
						}}
						disabled={busy}
					/>
				)}
				{error !== null && (
					<Alert color="red" py={6}>
						{error}
					</Alert>
				)}
				{pinEnabled && (
					<Button
						onClick={() => void handleUnlock()}
						loading={busy}
						disabled={pin.length !== 6}
					>
						{t("localLock.unlock")}
					</Button>
				)}
				<Button
					variant="subtle"
					color="red"
					onClick={() => void handleForgot()}
				>
					{t("localLock.forgot")}
				</Button>
			</Stack>
		</Modal>
	);
}
