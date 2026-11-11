import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	confirmNewKey,
	ensureAccountKeys,
	onMultiDeviceKeyRequired,
	onNewKeyConfirmationNeeded,
} from "../../e2ee/keys.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	activeToken: string | null;
}

type Mode = "multi-device" | "new-key";

export function MultiDeviceKeyModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const { logoutAll } = useAuth();
	const [mode, setMode] = useState<Mode | null>(null);

	useEffect(() => {
		const offMulti = onMultiDeviceKeyRequired((token) => {
			if (token === activeToken) setMode("multi-device");
		});
		const offNew = onNewKeyConfirmationNeeded((token) => {
			if (token === activeToken) setMode("new-key");
		});
		return () => {
			offMulti();
			offNew();
		};
	}, [activeToken]);

	if (mode === null) return null;

	const multi = mode === "multi-device";

	return (
		<Modal
			opened
			onClose={() => setMode(null)}
			title={t(multi ? "backup.multiDeviceTitle" : "backup.newKeyTitle")}
			size="sm"
			centered
		>
			<Stack gap="md">
				<Alert
					color={multi ? "yellow" : "orange"}
					title={t(
						multi ? "backup.multiDeviceAlertTitle" : "backup.newKeyAlertTitle",
					)}
				>
					<Text size="sm">
						{t(multi ? "backup.multiDevicePrompt" : "backup.newKeyPrompt")}
					</Text>
					<Text size="sm" mt="xs">
						{t(multi ? "backup.multiDeviceWarning" : "backup.newKeyWarning")}
					</Text>
				</Alert>
				<Text size="sm">
					{t(multi ? "backup.multiDeviceAdvice" : "backup.newKeyAdvice")}
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={() => setMode(null)}>
						{t("backup.close")}
					</Button>
					<Button
						color={multi ? "red" : "orange"}
						onClick={() => {
							setMode(null);
							if (multi) {
								logoutAll();
								return;
							}
							confirmNewKey();
							void ensureAccountKeys(activeToken ?? undefined).then(
								() => window.location.reload(),
								() => undefined,
							);
						}}
					>
						{t(multi ? "backup.multiDeviceLogoutAll" : "backup.newKeyConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
