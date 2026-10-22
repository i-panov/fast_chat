import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

interface Props {
	open: boolean;
	peerNick: string;
	onAccept: () => void;
	onReject: () => void;
}

// IncomingCallOverlay is the window of the incoming call. The user takes the
// call himself: the camera is only asked for when he presses the button.
export function IncomingCallOverlay({
	open,
	peerNick,
	onAccept,
	onReject,
}: Props) {
	const { t } = useTranslation();

	return (
		<Modal opened={open} onClose={onReject} withCloseButton={false} centered>
			<Stack>
				<Text fw={600}>{t("call.incomingFrom", { nick: peerNick })}</Text>
				<Group>
					<Button color="green" onClick={onAccept}>
						{t("call.accept")}
					</Button>
					<Button color="red" variant="light" onClick={onReject}>
						{t("call.reject")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
