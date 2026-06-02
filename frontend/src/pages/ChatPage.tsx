import { Center, Paper, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { AudioPlayerBar } from "../components/chat/AudioPlayerBar.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { ThreadView } from "../components/chat/ThreadView.tsx";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { otherNick } from "../utils/chat.ts";

function ChatHeader({
	title,
	badge,
	typingNick,
}: {
	title: string;
	badge?: string;
	typingNick?: string;
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
			<Text fw={600}>
				@{title}
				{badge !== undefined && (
					<Text component="span" size="xs" c="dimmed" ml={8}>
						{t("chat.newChat")}
					</Text>
				)}
			</Text>
			{typingNick !== undefined && (
				<Text size="xs" c="dimmed">
					{t("chat.typing", { nick: typingNick })}
				</Text>
			)}
		</Paper>
	);
}

export function ChatPage() {
	const s = useChatPage();
	const { t } = useTranslation();

	if (s.activeAccount === null || s.user === null) {
		return null;
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
									<ChatHeader title={s.pendingChatNick ?? ""} badge="newChat" />
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
									<ChatHeader
										title={otherNick(s.activeChat.members, s.user.id)}
										typingNick={s.typingUsers[s.activeChatId ?? ""]?.[0]?.nick}
									/>
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
									/>
									<InputBar
										text={s.inputText}
										onTextChange={s.setInputText}
										onSubmit={s.handleSend}
										editing={s.editingMessage !== null}
										onCancelEdit={s.handleCancelEdit}
										replyToNick={s.replyToMessage?.fromNick}
										replyToText={s.replyToMessage?.text}
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
		</Stack>
	);
}
