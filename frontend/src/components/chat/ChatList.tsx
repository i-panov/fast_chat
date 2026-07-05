import { Avatar, Button, Group, Loader, ScrollArea, Text } from "@mantine/core";
import { Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { Chat } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { chatTitle } from "../../utils/chat.ts";
import { OnlineDot } from "../shared/OnlineDot.tsx";

function ChatAvatar({
	avatarUrl,
	title,
	isGroup,
}: {
	avatarUrl: string | undefined;
	title: string;
	isGroup: boolean;
}) {
	const { activeAccount } = useAuth();
	const { blobUrl, loading } = useFileUrl(
		isGroup && avatarUrl ? avatarUrl : undefined,
		activeAccount?.token,
	);

	if (isGroup && avatarUrl && blobUrl) {
		return (
			<img
				src={blobUrl}
				alt=""
				style={{
					width: 28,
					height: 28,
					borderRadius: "50%",
					objectFit: "cover",
					flexShrink: 0,
				}}
			/>
		);
	}
	if (isGroup && avatarUrl && loading) {
		return <Loader size="sm" />;
	}
	if (isGroup) {
		return (
			<Avatar size={28} radius="xl" color="blue">
				{title.charAt(0).toUpperCase() || "#"}
			</Avatar>
		);
	}
	return null;
}

interface Props {
	chats: Chat[];
	activeChatId: string | null;
	userId: string;
	onSelectChat: (chatId: string) => void;
}

export function ChatList({ chats, activeChatId, userId, onSelectChat }: Props) {
	const { t } = useTranslation();

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
				const otherMember = isGroup
					? undefined
					: chat.members.find((m) => m.id !== userId);
				const isOnline = otherMember?.online ?? false;
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
							<ChatAvatar
								avatarUrl={chat.avatarUrl}
								title={title}
								isGroup={isGroup}
							/>
							<div style={{ minWidth: 0, flex: 1 }}>
								<Group gap={4} wrap="nowrap">
									<Text size="sm" truncate>
										{isGroup ? title : `@${title}`}
									</Text>
									{!isGroup && <OnlineDot online={isOnline} />}
								</Group>
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
