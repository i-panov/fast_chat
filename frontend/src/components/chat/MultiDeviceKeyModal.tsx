import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	confirmIdentityReplacement,
	createNewKey,
	onIdentityReplacementNeeded,
	onNewKeyConfirmationNeeded,
} from "../../e2ee/keys.ts";

interface Props {
	activeToken: string | null;
}

type AskMode = "new" | "replace-identity";

// NewKeyConfirmationModal asks before generating the first key on an account:
// old messages cannot be read with it, so the choice must be explicit. When
// the server still publishes an identity, a new key also replaces it and a
// second, stronger warning is required.
export function MultiDeviceKeyModal({ activeToken }: Props) {
	const { t } = useTranslation();
	const [modalToken, setModalToken] = useState<string | null>(null);
	const [mode, setMode] = useState<AskMode>("new");
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setModalToken(null);
		setMode("new");
		setBusy(false);
		const offNew = onNewKeyConfirmationNeeded((token) => {
			if (token === activeToken) setModalToken(token);
		});
		const offIdentity = onIdentityReplacementNeeded((token) => {
			if (token === activeToken) {
				setMode("replace-identity");
				setModalToken(token);
			}
		});
		return () => {
			offNew();
			offIdentity();
		};
	}, [activeToken]);

	if (modalToken === null) return null;

	const replacing = mode === "replace-identity";

	return (
		<Modal
			opened
			onClose={() => setModalToken(null)}
			title={t(
				replacing ? "backup.identityReplaceTitle" : "backup.newKeyTitle",
			)}
			size="sm"
			centered
		>
			<Stack gap="md">
				<Alert
					color={replacing ? "red" : "orange"}
					title={t(
						replacing
							? "backup.identityReplaceAlertTitle"
							: "backup.newKeyAlertTitle",
					)}
				>
					<Text size="sm">
						{t(
							replacing
								? "backup.identityReplacePrompt"
								: "backup.newKeyPrompt",
						)}
					</Text>
					<Text size="sm" mt="xs">
						{t(
							replacing
								? "backup.identityReplaceWarning"
								: "backup.newKeyWarning",
						)}
					</Text>
				</Alert>
				<Text size="sm">
					{t(
						replacing ? "backup.identityReplaceAdvice" : "backup.newKeyAdvice",
					)}
				</Text>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={() => setModalToken(null)}>
						{t("backup.close")}
					</Button>
					<Button
						color={replacing ? "red" : "orange"}
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
							if (replacing) confirmIdentityReplacement();
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
						{t(
							replacing
								? "backup.identityReplaceConfirm"
								: "backup.newKeyConfirm",
						)}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
