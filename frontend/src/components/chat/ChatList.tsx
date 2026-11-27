import {
	Avatar,
	Button,
	Group,
	Loader,
	Menu,
	ScrollArea,
	Text,
} from "@mantine/core";
import { Star, Trash2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useSyncStatus } from "../../hooks/useSyncStatus.ts";
import type { Chat } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { chatTitle } from "../../utils/chat.ts";
import { OnlineDot } from "../shared/OnlineDot.tsx";

function ChatAvatar({
	avatarUrl,
	title,
	isGroup,
	isSelf,
}: {
	avatarUrl: string | undefined;
	title: string;
	isGroup: boolean;
	isSelf: boolean;
}) {
	const { activeAccount } = useAuth();
	const { blobUrl, loading } = useFileUrl(
		!isSelf && avatarUrl ? avatarUrl : undefined,
		activeAccount?.token,
	);

	if (isSelf) {
		return (
			<Avatar size={28} radius="xl" color="yellow">
				<Star size={16} />
			</Avatar>
		);
	}
	if (!isSelf && avatarUrl && blobUrl) {
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
	if (!isSelf && avatarUrl && loading) {
		return <Loader size="sm" />;
	}
	return (
		<Avatar size={28} radius="xl" color="blue">
			{title.charAt(0).toUpperCase() || (isGroup ? "#" : "?")}
		</Avatar>
	);
}

interface Props {
	chats: Chat[];
	activeChatId: string | null;
	userId: string;
	loading?: boolean;
	onSelectChat: (chatId: string) => void;
	onDeleteChat?: (chat: Chat) => void;
}

export function ChatList({
	chats,
	activeChatId,
	userId,
	loading,
	onSelectChat,
	onDeleteChat,
}: Props) {
	const { t } = useTranslation();
	const syncState = useSyncStatus();
	// An empty list during the first sync is not "no chats yet".
	const showLoading =
		chats.length === 0 && (loading === true || syncState === "syncing");
	const titleCounts = new Map<string, number>();
	for (const chat of chats) {
		const title = chatTitle(chat, userId);
		titleCounts.set(title, (titleCounts.get(title) ?? 0) + 1);
	}

	return (
		<ScrollArea style={{ flex: 1 }}>
			{showLoading && (
				<Group justify="center" py={32}>
					<Loader size="sm" aria-label={t("chat.loading")} />
				</Group>
			)}
			{!showLoading && chats.length === 0 && (
				<Text ta="center" c="dimmed" size="sm" py={32}>
					{t("chat.noChats")}
				</Text>
			)}
			{chats.map((chat) => {
				const isGroup = chat.type === "group";
				const isSelf = chat.type === "self";
				const title = chatTitle(chat, userId);
				const otherMember =
					isGroup || isSelf
						? undefined
						: chat.members.find((m) => m.id !== userId);
				const isOnline = otherMember?.online ?? false;
				// Two accounts with the same nick on different servers would
				// otherwise look identical in the list.
				const domain =
					!isGroup && !isSelf && (titleCounts.get(title) ?? 0) > 1
						? otherMember?.id.split(":").slice(1).join(":")
						: undefined;
				const displayTitle =
					domain !== undefined && domain !== ""
						? `${title} · ${domain}`
						: title;
				// A group is removed for everyone, so only its owner may do it.
				// Favorites are not deletable; a private chat is removed for
				// the current user only.
				const canDelete =
					onDeleteChat !== undefined &&
					!isSelf &&
					(!isGroup || chat.ownerId === userId);

				const row = (
					<Button
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
						aria-current={chat.id === activeChatId ? "true" : undefined}
					>
						<Group gap={8} wrap="nowrap" style={{ width: "100%" }}>
							<ChatAvatar
								avatarUrl={isGroup ? chat.avatarUrl : otherMember?.avatarUrl}
								title={title}
								isGroup={isGroup}
								isSelf={isSelf}
							/>
							<div style={{ minWidth: 0, flex: 1 }}>
								<Group gap={4} wrap="nowrap">
									<Text size="sm" truncate>
										{displayTitle}
									</Text>
									{!isGroup && !isSelf && <OnlineDot online={isOnline} />}
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

				if (!canDelete) {
					return <div key={chat.id}>{row}</div>;
				}

				return (
					<Menu key={chat.id} shadow="md" withinPortal>
						<Menu.ContextMenu>{row}</Menu.ContextMenu>
						<Menu.Dropdown>
							<Menu.Item
								color="red"
								leftSection={<Trash2 size={14} />}
								onClick={() => onDeleteChat(chat)}
							>
								{t("chat.deleteChat")}
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>
				);
			})}
		</ScrollArea>
	);
}
