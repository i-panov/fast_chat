import { Button, Group, Modal, ScrollArea, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { Chat, Message } from "../../types/api.ts";
import { chatTitle } from "../../utils/chat.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	chats: Chat[];
	userId: string;
	message: Message | null;
	onForward: (chatId: string) => void;
}

export function ForwardModal({
	open,
	onClose,
	chats,
	userId,
	message,
	onForward,
}: Props) {
	const { t } = useTranslation();

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("forward.title")}
			size="sm"
			centered
		>
			<Stack gap="sm">
				{message !== null && (
					<Text size="xs" c="dimmed" truncate="end">
						{message.text}
					</Text>
				)}
				<ScrollArea.Autosize mah={360}>
					<Stack gap={4}>
						{chats.length === 0 && (
							<Text size="sm" c="dimmed">
								{t("forward.empty")}
							</Text>
						)}
						{chats.map((chat) => (
							<Button
								key={chat.id}
								variant="subtle"
								color="gray"
								fullWidth
								justify="flex-start"
								onClick={() => onForward(chat.id)}
							>
								<Group gap="xs" wrap="nowrap">
									<Text size="sm">
										{chat.type === "group"
											? chat.name || t("chat.groupFallback")
											: `@${chatTitle(chat, userId)}`}
									</Text>
								</Group>
							</Button>
						))}
					</Stack>
				</ScrollArea.Autosize>
			</Stack>
		</Modal>
	);
}
