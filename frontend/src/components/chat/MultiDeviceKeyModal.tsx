import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { onMultiDeviceKeyRequired } from "../../e2ee/keys.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	activeToken: string | null;
}

export function MultiDeviceKeyModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const { logoutAll } = useAuth();
	const [open, setOpen] = useState(false);

	useEffect(() => {
		return onMultiDeviceKeyRequired((token) => {
			if (token === activeToken) {
				setOpen(true);
			}
		});
	}, [activeToken]);

	if (!open) return null;

	return (
		<Modal
			opened={open}
			onClose={() => setOpen(false)}
			title={t("backup.multiDeviceTitle")}
			size="sm"
			centered
		>
			<Stack gap="md">
				<Alert color="yellow" title={t("backup.multiDeviceAlertTitle")}>
					<Text size="sm">{t("backup.multiDevicePrompt")}</Text>
					<Text size="sm" mt="xs">
						{t("backup.multiDeviceWarning")}
					</Text>
				</Alert>
				<Text size="sm">{t("backup.multiDeviceAdvice")}</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={() => setOpen(false)}>
						{t("backup.close")}
					</Button>
					<Button
						color="red"
						onClick={() => {
							setOpen(false);
							logoutAll();
						}}
					>
						{t("backup.multiDeviceLogoutAll")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
