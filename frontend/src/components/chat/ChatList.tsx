import { Avatar, Button, Group, Image, ScrollArea, Text } from "@mantine/core";
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chat } from "../../api.ts";
import { useAuth } from "../../useAuth.tsx";
import { chatTitle, withToken } from "../../utils/chat.ts";

interface Props {
	chats: Chat[];
	activeChatId: string | null;
	userId: string;
	onSelectChat: (chatId: string) => void;
}

export function ChatList({ chats, activeChatId, userId, onSelectChat }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const token = activeAccount?.token;

	return (
		<ScrollArea style={{ flex: 1 }}>
			{chats.length === 0 && (
				<Text ta="center" c="dimmed" size="sm" py={32}>
					{t("chat.noChats")}
				</Text>
			)}
			{chats.map((chat) => {
				const isGroup = chat.type === "group";
				const title = chatTitle(chat, userId);
				return (
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
						<Group gap={8} wrap="nowrap" style={{ width: "100%" }}>
							{isGroup &&
							chat.avatarUrl !== undefined &&
							chat.avatarUrl !== "" ? (
								<Image
									src={withToken(chat.avatarUrl, token)}
									alt={t("chat.avatarAlt")}
									w={28}
									h={28}
									radius="xl"
									fit="cover"
								/>
							) : isGroup ? (
								<Avatar size={28} radius="xl" color="blue">
									{title.charAt(0).toUpperCase() || "#"}
								</Avatar>
							) : null}
							<div style={{ minWidth: 0, flex: 1 }}>
								<Text size="sm" truncate>
									{isGroup ? title : `@${title}`}
								</Text>
								{isGroup && (
									<Group gap={4} c="dimmed">
										<Users size={11} />
										<Text size="xs" c="dimmed">
											{t("chat.membersCount", { count: chat.members.length })}
										</Text>
									</Group>
								)}
							</div>
						</Group>
					</Button>
				);
			})}
		</ScrollArea>
	);
}
