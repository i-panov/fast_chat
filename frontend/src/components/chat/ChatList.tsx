import { Button, ScrollArea, Text } from "@mantine/core";
import type { Chat } from "../../api.ts";
import { otherNick } from "../../utils/chat.ts";

interface Props {
	chats: Chat[];
	activeChatId: string | null;
	userId: string;
	onSelectChat: (chatId: string) => void;
}

export function ChatList({ chats, activeChatId, userId, onSelectChat }: Props) {
	return (
		<ScrollArea style={{ flex: 1 }}>
			{chats.length === 0 && (
				<Text ta="center" c="dimmed" size="sm" py={32}>
					No chats yet. Search for a user above to start one.
				</Text>
			)}
			{chats.map((chat) => (
				<Button
					key={chat.id}
					variant="subtle"
					color="gray"
					fullWidth
					justify="flex-start"
					style={{
						...(chat.id === activeChatId
							? {
									background: "var(--mantine-color-dark-5)",
									borderLeft: "3px solid var(--mantine-color-blue-7)",
								}
							: {}),
						borderRadius: 0,
						borderBottom: "1px solid var(--mantine-color-dark-4)",
						height: "auto",
						paddingTop: 8,
						paddingBottom: 8,
					}}
					onClick={() => onSelectChat(chat.id)}
				>
					<Text size="sm">@{otherNick(chat.members, userId)}</Text>
				</Button>
			))}
		</ScrollArea>
	);
}
