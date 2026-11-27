import { useEffect, useRef, useState } from "react";
import type { KeyPair } from "../../e2ee/crypto.ts";
import {
	getMyKeyPair,
	getServerBackupState,
	requestRecoveryAfterForgotPin,
} from "../../e2ee/keys.ts";
import { useLocalLockRevision } from "../../hooks/useLocalLockRevision.ts";
import { BackupSettingsModal } from "./BackupSettingsModal.tsx";

const DISMISSED_PREFIX = "e2ee.backupGateDismissed:";

function wasDismissed(token: string): boolean {
	try {
		return sessionStorage.getItem(`${DISMISSED_PREFIX}${token}`) === "1";
	} catch {
		return false;
	}
}

function rememberDismissed(token: string): void {
	try {
		sessionStorage.setItem(`${DISMISSED_PREFIX}${token}`, "1");
	} catch {
		// Storage blocked: the in-memory ref still covers this mount.
	}
}

// BackupSetupGate blocks the first E2EE use until the account has a
// password-wrapped server backup. Without it a new device could never recover
// the master key.
export function BackupSetupGate({
	activeToken,
}: {
	activeToken: string | null;
}) {
	const [required, setRequired] = useState(false);
	const [keyPair, setKeyPair] = useState<KeyPair | null>(null);
	const lockRevision = useLocalLockRevision();
	// "Continue without a backup" must survive the next online event and lock
	// revision: the server still has no backup, so a re-check would reopen an
	// unclosable modal and make the escape look broken.
	const dismissedForToken = useRef<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		// Re-check when a key is created, restored or unlocked.
		void lockRevision;
		if (activeToken === null) {
			setRequired(false);
			return;
		}
		void getMyKeyPair()
			.then(async (pair) => {
				if (cancelled) return;
				setKeyPair(pair);
				if (pair === null) {
					setRequired(false);
					return;
				}
				const state = await getServerBackupState(activeToken).catch(
					() => "unknown",
				);
				if (state === "local-stale") {
					// Server backup is newer than this device: recovery is the
					// only valid action, saving would overwrite that copy.
					requestRecoveryAfterForgotPin(activeToken);
					if (!cancelled) setRequired(false);
					return;
				}
				// A missing/legacy/stale backup needs a fresh one. A network
				// failure must not lock the user in an unclosable modal.
				if (!cancelled) {
					setRequired(
						dismissedForToken.current !== activeToken &&
							(state === "none" || state === "legacy" || state === "stale"),
					);
				}
			})
			.catch(() => {
				if (!cancelled) setRequired(false);
			});
		return () => {
			cancelled = true;
		};
	}, [activeToken, lockRevision]);

	// An offline first load stayed "unknown" and skipped the gate forever.
	// Re-check as soon as the connection returns.
	useEffect(() => {
		if (activeToken === null) return;
		let cancelled = false;
		const onOnline = () => {
			if (wasDismissed(activeToken)) return;
			void getMyKeyPair()
				.then(async (pair) => {
					if (cancelled) return;
					if (pair === null) {
						setRequired(false);
						return;
					}
					const state = await getServerBackupState(activeToken).catch(
						() => "unknown",
					);
					if (cancelled) return;
					if (state === "local-stale") {
						requestRecoveryAfterForgotPin(activeToken);
						setRequired(false);
						return;
					}
					setRequired(
						dismissedForToken.current !== activeToken &&
							(state === "none" || state === "legacy" || state === "stale"),
					);
				})
				.catch(() => {});
		};
		window.addEventListener("online", onOnline);
		return () => {
			cancelled = true;
			window.removeEventListener("online", onOnline);
		};
	}, [activeToken]);

	if (activeToken === null) return null;

	return (
		<BackupSettingsModal
			open={required}
			required
			onClose={() => {
				// The modal's only close path in required mode is the explicit
				// "continue without a backup" escape after a failed save; do not
				// re-open it from here or that escape would do nothing.
				dismissedForToken.current = activeToken;
				rememberDismissed(activeToken);
				setRequired(false);
			}}
			token={activeToken}
			keyPair={keyPair}
		/>
	);
}
