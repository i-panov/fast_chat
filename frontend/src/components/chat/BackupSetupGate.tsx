import { useEffect, useState } from "react";
import type { KeyPair } from "../../e2ee/crypto.ts";
import {
	getMyKeyPair,
	getServerBackupState,
	requestRecoveryAfterForgotPin,
} from "../../e2ee/keys.ts";
import { useLocalLockRevision } from "../../hooks/useLocalLockRevision.ts";
import { BackupSettingsModal } from "./BackupSettingsModal.tsx";

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
						state === "none" || state === "legacy" || state === "stale",
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
						state === "none" || state === "legacy" || state === "stale",
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
				setRequired(false);
			}}
			token={activeToken}
			keyPair={keyPair}
		/>
	);
}
