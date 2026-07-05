import { ActionIcon, Center, Group, Paper, Stack, Text } from "@mantine/core";
import { Settings } from "lucide-react";
import type * as React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { AudioPlayerBar } from "../components/chat/AudioPlayerBar.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { CreateGroupModal } from "../components/chat/CreateGroupModal.tsx";
import { GroupSettingsModal } from "../components/chat/GroupSettingsModal.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { LocationPickerModal } from "../components/chat/LocationPickerModal.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { ThreadView } from "../components/chat/ThreadView.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { OnlineDot } from "../components/shared/OnlineDot.tsx";
import ChatContext from "../context/ChatContext.tsx";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { usePushNotifications } from "../hooks/usePushNotifications.ts";
import { chatTitle } from "../utils/chat.ts";

function ChatHeader({
	title,
	subtitle,
	badge,
	typingNick,
	online,
	onOpenSettings,
}: {
	title: string;
	subtitle?: string;
	badge?: string;
	typingNick?: string;
	online?: boolean;
	onOpenSettings?: () => void;
}) {
	const { t } = useTranslation();

	return (
		<Paper
			component="header"
			style={{
				padding: "12px 16px",
				borderRadius: 0,
				background: "var(--mantine-color-dark-8)",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
		>
			<Group justify="space-between" wrap="nowrap">
				<div style={{ minWidth: 0, flex: 1 }}>
					<Group gap={6} wrap="nowrap">
						<Text fw={600} truncate>
							{title}
							{badge !== undefined && (
								<Text component="span" size="xs" c="dimmed" ml={8}>
									{t("chat.newChat")}
								</Text>
							)}
						</Text>
						{online !== undefined && <OnlineDot online={online} />}
					</Group>
					{subtitle !== undefined && (
						<Text size="xs" c="dimmed">
							{subtitle}
						</Text>
					)}
					{typingNick !== undefined && (
						<Text size="xs" c="dimmed">
							{t("chat.typing", { nick: typingNick })}
						</Text>
					)}
				</div>
				{onOpenSettings !== undefined && (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={onOpenSettings}
						aria-label={t("chat.settings")}
					>
						<Settings size={18} />
					</ActionIcon>
				)}
			</Group>
		</Paper>
	);
}

export function ChatPage() {
	const s = useChatPage();
	const { t } = useTranslation();

	usePushNotifications(s.activeAccount?.token ?? "");

	useEffect(() => {
		function handleMessage(event: MessageEvent) {
			if (event.data?.type !== "NAVIGATE_TO_CHAT") return;

			const { chatId, threadId } = event.data;
			s.selectChat(chatId);

			if (threadId) {
				s.handleOpenThread(threadId);
			}
		}

		navigator.serviceWorker.addEventListener("message", handleMessage);

		return () => {
			navigator.serviceWorker.removeEventListener("message", handleMessage);
		};
	}, [s.selectChat, s.handleOpenThread]);

	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const chatId = params.get("chatId");
		if (!chatId) return;

		const threadId = params.get("threadId");

		params.delete("chatId");
		params.delete("threadId");
		const cleanSearch = params.toString();
		window.history.replaceState(
			{},
			"",
			cleanSearch ? `/chat?${cleanSearch}` : "/chat",
		);

		s.selectChat(chatId);
		if (threadId) {
			s.handleOpenThread(threadId);
		}
	}, [s.selectChat, s.handleOpenThread]);

	if (s.activeAccount === null || s.user === null) {
		return null;
	}

	const typingNicks =
		s.activeChatId !== null ? (s.typingUsers[s.activeChatId] ?? []) : [];
	const typingNick = typingNicks[0]?.nick;

	let header: React.ReactElement | null = null;
	let showAuthorForGroup = false;

	if (s.pendingChatWith !== null) {
		header = (
			<ChatHeader title={`@${s.pendingChatNick ?? ""}`} badge="newChat" />
		);
	} else if (s.activeChat !== undefined) {
		const isGroup = s.activeChat.type === "group";
		const isSelf = s.activeChat.type === "self";
		const title = isSelf
			? chatTitle(s.activeChat, s.user.id)
			: isGroup
				? s.activeChat.name || t("chat.groupFallback")
				: `@${chatTitle(s.activeChat, s.user.id)}`;
		const subtitle = isGroup
			? t("chat.membersCount", { count: s.activeChat.members.length })
			: undefined;
		const userId = s.user.id;
		const otherMember =
			isGroup || isSelf
				? undefined
				: s.activeChat.members.find((m) => m.id !== userId);
		header = (
			<ChatHeader
				title={title}
				subtitle={subtitle}
				typingNick={typingNick}
				online={isGroup || isSelf ? undefined : (otherMember?.online ?? false)}
				onOpenSettings={
					isGroup
						? () => {
								if (s.activeChat !== undefined) {
									s.openGroupSettings(s.activeChat.id);
								}
							}
						: undefined
				}
			/>
		);
		showAuthorForGroup = isGroup;
	}

	return (
		<ChatContext.Provider value={s}>
			<Stack h="100%" gap={0}>
				<AccountSwitcher
					open={s.switcherOpen}
					onClose={() => s.setSwitcherOpen(false)}
					onLogout={s.logout}
				/>
				<AppHeader onSwitcherToggle={() => s.setSwitcherOpen(true)} />
				<AudioPlayerBar />
				<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
					<ErrorBoundary>
						<Paper
							component="aside"
							style={{
								width: "300px",
								minWidth: "300px",
								borderRadius: 0,
								borderRight: "1px solid var(--mantine-color-dark-4)",
								background: "var(--mantine-color-dark-8)",
							}}
						>
							<Stack h="100%" gap={0}>
								<SearchBox
									query={s.searchQuery}
									results={s.searchResults}
									showResults={s.showSearchResults}
									onQueryChange={s.handleSearchChange}
									onSelectUser={s.selectPendingChat}
									onCreateGroup={() => s.setCreateGroupOpen(true)}
								/>
								<ChatList
									chats={s.chats}
									activeChatId={s.activeChatId}
									userId={s.user.id}
									onSelectChat={s.selectChat}
								/>
							</Stack>
						</Paper>
					</ErrorBoundary>
					<Paper
						component="main"
						style={{
							flex: 1,
							minHeight: 0,
							borderRadius: 0,
							background: "var(--mantine-color-dark-9)",
						}}
					>
						{s.activeThread !== null ? (
							<ThreadView />
						) : (
							<Stack h="100%" gap={0}>
								{s.pendingChatWith !== null ? (
									<>
										{header}
										<div
											style={{
												flex: 1,
												display: "flex",
												alignItems: "center",
												justifyContent: "center",
											}}
										>
											<Text ta="center" c="dimmed" size="sm">
												{t("chat.sendTo", { nick: s.pendingChatNick ?? "" })}
											</Text>
										</div>
										<InputBar
											text={s.inputText}
											onTextChange={s.setInputText}
											onSubmit={s.handleSend}
											editing={s.editingMessage !== null}
											onCancelEdit={s.handleCancelEdit}
											replyToNick={s.replyToMessage?.fromNick}
											replyToText={s.replyToMessage?.text}
											replyToFiles={s.replyToMessage?.files}
											onCancelReply={s.cancelReply}
											pendingFiles={s.pendingFiles}
											onAttachFiles={s.handleAttachFiles}
											onRemoveFile={s.handleRemoveFile}
											existingFiles={s.editingMessage?.files}
											onRemoveExistingFile={s.handleRemoveExistingFile}
											pendingLocation={s.pendingLocation}
											onOpenLocationPicker={s.openLocationPicker}
											onRemovePendingLocation={s.clearPendingLocation}
											existingLocation={s.editingMessage?.location ?? null}
											onRemoveExistingLocation={s.handleRemoveExistingLocation}
										/>
									</>
								) : s.activeChat === undefined ? (
									<Center style={{ flex: 1 }}>
										<Text ta="center" c="dimmed" size="sm">
											{t("chat.selectPrompt")}
										</Text>
									</Center>
								) : (
									<>
										{header}
										<MessageList
											messages={s.activeMessages}
											userId={s.user.id}
											chatId={s.activeChatId}
											token={s.activeAccount?.token}
											onDelete={s.handleDeleteMessage}
											onStartEdit={s.handleStartEdit}
											onReply={s.handleReply}
											editTTL={s.config?.messageEditTTL ?? 0}
											deleteTTL={s.config?.messageDeleteTTL ?? 0}
											hasMore={s.hasMore}
											isLoadingMore={s.isLoadingMore}
											onLoadMore={
												s.activeChatId !== null
													? () => s.loadMoreMessages(s.activeChatId)
													: undefined
											}
											onCreateThread={s.handleCreateThread}
											onOpenThread={s.handleOpenThread}
											messageToThread={s.messageToThread}
											threads={s.threads}
											onRetry={s.handleRetryMessage}
											onCancelSend={s.handleCancelSendMessage}
											showAuthorForGroup={showAuthorForGroup}
											isOffline={!s.isOnline}
										/>
										<InputBar
											text={s.inputText}
											onTextChange={s.setInputText}
											onSubmit={s.handleSend}
											editing={s.editingMessage !== null}
											onCancelEdit={s.handleCancelEdit}
											replyToNick={s.replyToMessage?.fromNick}
											replyToText={s.replyToMessage?.text}
											replyToFiles={s.replyToMessage?.files}
											onCancelReply={s.cancelReply}
											onTypingStart={() => {
												if (s.activeChatId !== null)
													s.handleTyping(s.activeChatId, true);
											}}
											onTypingStop={() => {
												if (s.activeChatId !== null)
													s.handleTyping(s.activeChatId, false);
											}}
											pendingFiles={s.pendingFiles}
											onAttachFiles={s.handleAttachFiles}
											onRemoveFile={s.handleRemoveFile}
											existingFiles={s.editingMessage?.files}
											onRemoveExistingFile={s.handleRemoveExistingFile}
											pendingLocation={s.pendingLocation}
											onOpenLocationPicker={s.openLocationPicker}
											onRemovePendingLocation={s.clearPendingLocation}
											existingLocation={s.editingMessage?.location ?? null}
											onRemoveExistingLocation={s.handleRemoveExistingLocation}
										/>
									</>
								)}
							</Stack>
						)}
					</Paper>
				</div>
				<CreateGroupModal
					open={s.createGroupOpen}
					onClose={() => s.setCreateGroupOpen(false)}
					onCreate={s.handleCreateGroup}
				/>
				<GroupSettingsModal
					open={s.groupSettingsChatId !== null}
					chat={s.groupSettings}
					onClose={s.closeGroupSettings}
					onRename={s.handleRenameGroup}
					onAddMember={s.handleAddGroupMember}
					onRemoveMember={s.handleRemoveGroupMember}
					onDelete={s.handleDeleteGroup}
					onUploadAvatar={s.handleUploadGroupAvatar}
				/>
				<LocationPickerModal
					open={s.locationPickerOpen}
					initial={s.pendingLocation}
					onClose={() => s.setLocationPickerOpen(false)}
					onConfirm={s.handleLocationConfirm}
				/>
			</Stack>
		</ChatContext.Provider>
	);
}
