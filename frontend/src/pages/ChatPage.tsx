import { Center, Paper, Stack, Text } from "@mantine/core";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { otherNick } from "../utils/chat.ts";

function ChatHeader({ title, badge }: { title: string; badge?: string }) {
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
						{badge}
					</Text>
				)}
			</Text>
		</Paper>
	);
}

export function ChatPage() {
	const s = useChatPage();

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
					<Stack h="100%" gap={0}>
						{s.pendingChatWith !== null ? (
							<>
								<ChatHeader title={s.pendingChatNick ?? ""} badge="New chat" />
								<div
									style={{
										flex: 1,
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
									}}
								>
									<Text ta="center" c="dimmed" size="sm">
										Send a message to start a chat with @{s.pendingChatNick}
									</Text>
								</div>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
									editing={s.editingMessage !== null}
									onCancelEdit={s.handleCancelEdit}
								/>
							</>
						) : s.activeChat === undefined ? (
							<Center style={{ flex: 1 }}>
								<Text ta="center" c="dimmed" size="sm">
									Select a chat or search for a user to start messaging
								</Text>
							</Center>
						) : (
							<>
								<ChatHeader
									title={otherNick(s.activeChat.members, s.user.id)}
								/>
								<MessageList
									messages={s.activeMessages}
									userId={s.user.id}
									onDelete={s.handleDeleteMessage}
									onStartEdit={s.handleStartEdit}
									editTTL={s.config?.messageEditTTL ?? 0}
									deleteTTL={s.config?.messageDeleteTTL ?? 0}
									hasMore={s.hasMore}
									isLoadingMore={s.isLoadingMore}
									onLoadMore={
										s.activeChatId !== null
											? () => s.loadMoreMessages(s.activeChatId)
											: undefined
									}
								/>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
									editing={s.editingMessage !== null}
									onCancelEdit={s.handleCancelEdit}
								/>
							</>
						)}
					</Stack>
				</Paper>
			</div>
		</Stack>
	);
}
