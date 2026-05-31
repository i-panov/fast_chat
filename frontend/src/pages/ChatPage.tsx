import { Center, Paper, ScrollArea, Stack, Text } from "@mantine/core";
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
			/>
			<AppHeader
				nick={s.activeAccount.user.nick}
				accountCount={s.accounts.length}
				onSwitcherToggle={() => s.setSwitcherOpen(true)}
				onLogout={s.logout}
			/>
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
								<ScrollArea style={{ flex: 1 }} p="md">
									<Text ta="center" c="dimmed" size="sm" py={32}>
										Send a message to start a chat with @{s.pendingChatNick}
									</Text>
								</ScrollArea>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
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
								<ScrollArea style={{ flex: 1 }} p="md">
									<MessageList
										messages={s.activeMessages}
										userId={s.user.id}
										onDelete={s.handleDeleteMessage}
									/>
								</ScrollArea>
								<InputBar
									text={s.inputText}
									onTextChange={s.setInputText}
									onSubmit={s.handleSend}
								/>
							</>
						)}
					</Stack>
				</Paper>
			</div>
		</Stack>
	);
}
