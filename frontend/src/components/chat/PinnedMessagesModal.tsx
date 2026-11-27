import {
	Button,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import { PinOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Message } from "../../types/api.ts";
import { formatDateTime } from "../../utils/chat.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	loading: boolean;
	messages: Message[];
	canUnpin: boolean;
	onUnpin: (messageId: string) => void;
}

function preview(message: Message, encryptedLabel: string): string {
	if (message.encrypted) return encryptedLabel;
	if (message.text !== "") return message.text;
	if ((message.files ?? []).length > 0) return "📎";
	if (message.location !== undefined) return "📍";
	return "—";
}

export function PinnedMessagesModal({
	open,
	onClose,
	loading,
	messages,
	canUnpin,
	onUnpin,
}: Props) {
	const { t } = useTranslation();

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("pins.title")}
			size="md"
			centered
		>
			<Stack gap="sm">
				{loading ? (
					<Group justify="center">
						<Loader size="sm" />
					</Group>
				) : messages.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("pins.empty")}
					</Text>
				) : (
					<ScrollArea.Autosize mah={420}>
						<Stack gap="xs">
							{messages.map((message) => (
								<Group
									key={message.id}
									justify="space-between"
									align="flex-start"
									wrap="nowrap"
									style={{
										padding: "8px 12px",
										border: "1px solid var(--mantine-color-dark-4)",
										borderRadius: 4,
									}}
								>
									<div style={{ minWidth: 0 }}>
										<Text size="xs" c="dimmed">
											@{message.fromNick} · {formatDateTime(message.createdAt)}
										</Text>
										<Text size="sm" truncate="end">
											{preview(message, t("pins.encrypted"))}
										</Text>
									</div>
									{canUnpin && (
										<Button
											size="compact-xs"
											variant="subtle"
											color="red"
											leftSection={<PinOff size={12} />}
											onClick={() => onUnpin(message.id)}
										>
											{t("pins.unpin")}
										</Button>
									)}
								</Group>
							))}
						</Stack>
					</ScrollArea.Autosize>
				)}
			</Stack>
		</Modal>
	);
}
