import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createNewKey, onNewKeyConfirmationNeeded } from "../../e2ee/keys.ts";

interface Props {
	activeToken: string | null;
}

// NewKeyConfirmationModal asks before generating the first key on an account:
// old messages cannot be read with it, so the choice must be explicit.
export function MultiDeviceKeyModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const [modalToken, setModalToken] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setModalToken(null);
		setBusy(false);
		const off = onNewKeyConfirmationNeeded((token) => {
			if (token === activeToken) setModalToken(token);
		});
		return off;
	}, [activeToken]);

	if (modalToken === null) return null;

	return (
		<Modal
			opened
			onClose={() => setModalToken(null)}
			title={t("backup.newKeyTitle")}
			size="sm"
			centered
		>
			<Stack gap="md">
				<Alert color="orange" title={t("backup.newKeyAlertTitle")}>
					<Text size="sm">{t("backup.newKeyPrompt")}</Text>
					<Text size="sm" mt="xs">
						{t("backup.newKeyWarning")}
					</Text>
				</Alert>
				<Text size="sm">{t("backup.newKeyAdvice")}</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={() => setModalToken(null)}>
						{t("backup.close")}
					</Button>
					<Button
						color="orange"
						loading={busy}
						onClick={() => {
							if (activeToken === null || modalToken !== activeToken) {
								notifications.show({
									message: t("error.newKeyFailed"),
									color: "red",
								});
								return;
							}
							setBusy(true);
							void createNewKey(activeToken)
								.then(() => window.location.reload())
								.catch(() => {
									notifications.show({
										message: t("error.newKeyFailed"),
										color: "red",
									});
								})
								.finally(() => setBusy(false));
						}}
					>
						{t("backup.newKeyConfirm")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
