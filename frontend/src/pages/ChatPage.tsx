import { ActionIcon, Center, Group, Paper, Stack, Text } from "@mantine/core";
import { Settings } from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { AudioPlayerBar } from "../components/chat/AudioPlayerBar.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { CreateGroupModal } from "../components/chat/CreateGroupModal.tsx";
import { GroupSettingsModal } from "../components/chat/GroupSettingsModal.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { ThreadView } from "../components/chat/ThreadView.tsx";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { chatTitle } from "../utils/chat.ts";

function ChatHeader({
	title,
	subtitle,
	badge,
	typingNick,
	onOpenSettings,
}: {
	title: string;
	subtitle?: string;
	badge?: string;
	typingNick?: string;
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
					<Text fw={600} truncate>
						{title}
						{badge !== undefined && (
							<Text component="span" size="xs" c="dimmed" ml={8}>
								{t("chat.newChat")}
							</Text>
						)}
					</Text>
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
		const title = isGroup
			? s.activeChat.name || t("chat.groupFallback")
			: `@${chatTitle(s.activeChat, s.user.id)}`;
		const subtitle = isGroup
			? t("chat.membersCount", { count: s.activeChat.members.length })
			: undefined;
		header = (
			<ChatHeader
				title={title}
				subtitle={subtitle}
				typingNick={typingNick}
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
		<Stack h="100%" gap={0}>
			<AccountSwitcher
				open={s.switcherOpen}
				onClose={() => s.setSwitcherOpen(false)}
				onLogout={s.logout}
			/>
			<AppHeader onSwitcherToggle={() => s.setSwitcherOpen(true)} />
			<AudioPlayerBar />
			<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
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
						<ThreadView
							thread={s.activeThread}
							messages={s.activeThreadMessages}
							userId={s.user.id}
							onBack={s.handleCloseThread}
							inputText={s.inputText}
							setInputText={s.setInputText}
							onSend={s.handleSendThreadMessage}
							onDelete={s.handleDeleteMessage}
							onStartEdit={s.handleStartEdit}
							onCancelEdit={s.handleCancelEdit}
							onReply={s.handleReply}
							editTTL={s.config?.messageEditTTL ?? 0}
							deleteTTL={s.config?.messageDeleteTTL ?? 0}
							editingMessage={s.editingMessage}
							hasMore={s.threadHasMore}
							isLoadingMore={s.threadIsLoadingMore}
							onLoadMore={s.loadMoreThreadMessages}
							onRetry={s.handleRetryThreadMessage}
							replyToNick={s.replyToMessage?.fromNick}
							replyToText={s.replyToMessage?.text}
							replyToFiles={s.replyToMessage?.files}
							onCancelReply={s.cancelReply}
							pendingFiles={s.pendingFiles}
							onAttachFiles={s.handleAttachFiles}
							onRemoveFile={s.handleRemoveFile}
							existingFiles={s.editingMessage?.files}
							onRemoveExistingFile={s.handleRemoveExistingFile}
						/>
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
										showAuthorForGroup={showAuthorForGroup}
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
		</Stack>
	);
}
