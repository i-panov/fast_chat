import { ActionIcon, Center, Group, Paper, Stack, Text } from "@mantine/core";
import { Settings } from "lucide-react";
import type * as React from "react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import { ActiveCallOverlay } from "../components/chat/ActiveCallOverlay.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { AudioPlayerBar } from "../components/chat/AudioPlayerBar.tsx";
import { CallButton } from "../components/chat/CallButton.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { CreateGroupModal } from "../components/chat/CreateGroupModal.tsx";
import { EndedCallNotice } from "../components/chat/EndedCallNotice.tsx";
import { GroupSettingsModal } from "../components/chat/GroupSettingsModal.tsx";
import { IncomingCallOverlay } from "../components/chat/IncomingCallOverlay.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { LocationPickerModal } from "../components/chat/LocationPickerModal.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { RecoveryModal } from "../components/chat/RecoveryModal.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { ThreadView } from "../components/chat/ThreadView.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { OnlineDot } from "../components/shared/OnlineDot.tsx";
import ChatContext from "../context/ChatContext.tsx";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { usePushNotifications } from "../hooks/usePushNotifications.ts";
import { chatTitle } from "../utils/chat.ts";

type ChatPageState = ReturnType<typeof useChatPage>;

// The columns of the page share the same colors.
const PANEL_BACKGROUND = "var(--mantine-color-dark-8)";
const PANEL_BORDER = "1px solid var(--mantine-color-dark-4)";

// callPanelOpen tells whether the panel of the call is shown: the call is
// going on, either way round.
function callPanelOpen(s: ChatPageState): boolean {
	return s.call.phase === "outgoing" || s.call.phase === "active";
}

// callPeerNick returns the nick of the other side of the call. The manager
// knows it for an incoming call; the chat of the call knows it for an
// outgoing one.
function callPeerNick(s: ChatPageState): string {
	if (s.call.peerNick) return s.call.peerNick;

	// The chat of the call knows the other side: the caller knows the chat
	// of the call, the callee knows the peer of it.
	const chat =
		s.chats.find((c) => c.id === s.call.chatId) ??
		s.chats.find((c) => c.members.some((m) => m.id === s.call.peerId));
	const peer = chat?.members.find((m) => m.id !== s.user?.id);

	return peer?.nick ?? "";
}

function ChatHeader({
	title,
	subtitle,
	badge,
	typingNick,
	online,
	callButton,
	onOpenSettings,
}: {
	title: string;
	subtitle?: string;
	badge?: string;
	typingNick?: string;
	online?: boolean;
	callButton?: React.ReactNode;
	onOpenSettings?: () => void;
}) {
	const { t } = useTranslation();

	return (
		<Paper
			component="header"
			style={{
				padding: "12px 16px",
				borderRadius: 0,
				background: PANEL_BACKGROUND,
				borderBottom: PANEL_BORDER,
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
				<Group gap={4} wrap="nowrap">
					{callButton}
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
			</Group>
		</Paper>
	);
}

function ChatHeaderSlot({
	s,
	userId,
}: {
	s: ChatPageState;
	userId: string;
}): React.ReactElement | null {
	const { t } = useTranslation();

	const typingNicks =
		s.activeChatId !== null ? (s.typingUsers[s.activeChatId] ?? []) : [];
	const typingNick = typingNicks[0]?.nick;

	if (s.pendingChatWith !== null) {
		return <ChatHeader title={`@${s.pendingChatNick ?? ""}`} badge="newChat" />;
	}

	if (s.activeChat === undefined) {
		return null;
	}

	const isGroup = s.activeChat.type === "group";
	const isSelf = s.activeChat.type === "self";
	const title = isSelf
		? chatTitle(s.activeChat, userId)
		: isGroup
			? s.activeChat.name || t("chat.groupFallback")
			: `@${chatTitle(s.activeChat, userId)}`;
	const subtitle = isGroup
		? t("chat.membersCount", { count: s.activeChat.members.length })
		: undefined;
	const otherMember =
		isGroup || isSelf
			? undefined
			: s.activeChat.members.find((m) => m.id !== userId);
	// A call that is going on keeps the button out of reach: the manager
	// refuses a second call anyway.
	const callBusy = s.call.phase !== "idle" && s.call.phase !== "ended";

	return (
		<ChatHeader
			title={title}
			subtitle={subtitle}
			typingNick={typingNick}
			online={isGroup || isSelf ? undefined : (otherMember?.online ?? false)}
			callButton={
				<CallButton
					peer={otherMember}
					localUserId={userId}
					disabled={callBusy}
					onCall={() => {
						if (s.activeChatId !== null) {
							void s.startCall(s.activeChatId);
						}
					}}
				/>
			}
			onOpenSettings={
				isGroup
					? () => {
							if (s.activeChat !== undefined) {
								void s.openGroupSettings(s.activeChat.id);
							}
						}
					: undefined
			}
		/>
	);
}

function ChatSidebar({ s, userId }: { s: ChatPageState; userId: string }) {
	return (
		<Paper
			component="aside"
			style={{
				width: "300px",
				minWidth: "300px",
				borderRadius: 0,
				borderRight: PANEL_BORDER,
				background: PANEL_BACKGROUND,
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
					userId={userId}
					onSelectChat={s.selectChat}
				/>
			</Stack>
		</Paper>
	);
}

function ChatInputBar({
	s,
	withTyping,
}: {
	s: ChatPageState;
	withTyping?: boolean;
}) {
	return (
		<InputBar
			text={s.inputText}
			onTextChange={s.setInputText}
			onSubmit={(e) => {
				void s.handleSend(e);
			}}
			editing={s.editingMessage !== null}
			onCancelEdit={s.handleCancelEdit}
			replyToNick={s.replyToMessage?.fromNick}
			replyToText={s.replyToMessage?.text}
			replyToFiles={s.replyToMessage?.files}
			onCancelReply={s.cancelReply}
			onTypingStart={
				withTyping
					? () => {
							if (s.activeChatId !== null) s.handleTyping(s.activeChatId, true);
						}
					: undefined
			}
			onTypingStop={
				withTyping
					? () => {
							if (s.activeChatId !== null)
								s.handleTyping(s.activeChatId, false);
						}
					: undefined
			}
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
	);
}

function PendingChatView({ s, userId }: { s: ChatPageState; userId: string }) {
	const { t } = useTranslation();

	return (
		<>
			<ChatHeaderSlot s={s} userId={userId} />
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
			<ChatInputBar s={s} />
		</>
	);
}

function ActiveChatView({ s, userId }: { s: ChatPageState; userId: string }) {
	const showAuthorForGroup = s.activeChat?.type === "group";

	return (
		<>
			<ChatHeaderSlot s={s} userId={userId} />
			<MessageList
				messages={s.activeMessages}
				userId={userId}
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
						? () => {
								void s.loadMoreMessages(s.activeChatId);
							}
						: undefined
				}
				onCreateThread={(chatId, messageId) => {
					void s.handleCreateThread(chatId, messageId);
				}}
				onOpenThread={(threadId) => {
					void s.handleOpenThread(threadId);
				}}
				messageToThread={s.messageToThread}
				threads={s.threads}
				onRetry={(chatId, messageId) => {
					void s.handleRetryMessage(chatId, messageId);
				}}
				onCancelSend={(chatId, messageId) => {
					void s.handleCancelSendMessage(chatId, messageId);
				}}
				showAuthorForGroup={showAuthorForGroup}
				isOffline={!s.isOnline}
			/>
			<ChatInputBar s={s} withTyping />
		</>
	);
}

export function ChatPage() {
	const s = useChatPage();
	const { selectChat, handleOpenThread } = s;
	const { t } = useTranslation();

	usePushNotifications(s.activeAccount?.token ?? "");

	useEffect(() => {
		function handleMessage(event: MessageEvent) {
			const data = event.data as {
				type?: string;
				chatId?: string;
				threadId?: string;
			};
			if (data.type !== "NAVIGATE_TO_CHAT") return;
			if (typeof data.chatId !== "string") return;

			selectChat(data.chatId);

			if (typeof data.threadId === "string") {
				handleOpenThread(data.threadId);
			}
		}

		navigator.serviceWorker.addEventListener("message", handleMessage);

		return () => {
			navigator.serviceWorker.removeEventListener("message", handleMessage);
		};
	}, [selectChat, handleOpenThread]);

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

		selectChat(chatId);
		if (threadId) {
			handleOpenThread(threadId);
		}
	}, [selectChat, handleOpenThread]);

	if (s.activeAccount === null || s.user === null) {
		return null;
	}

	return (
		<ChatContext.Provider value={s}>
			<Stack h="100%" gap={0}>
				<AccountSwitcher
					open={s.switcherOpen}
					onClose={() => s.setSwitcherOpen(false)}
					onLogout={s.logout}
				/>
				<RecoveryModal activeToken={s.activeAccount?.token ?? null} />
				<AppHeader onSwitcherToggle={() => s.setSwitcherOpen(true)} />
				<AudioPlayerBar />
				<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
					<ErrorBoundary>
						<ChatSidebar s={s} userId={s.user.id} />
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
									<PendingChatView s={s} userId={s.user.id} />
								) : s.activeChat === undefined ? (
									<Center style={{ flex: 1 }}>
										<Text ta="center" c="dimmed" size="sm">
											{t("chat.selectPrompt")}
										</Text>
									</Center>
								) : (
									<ActiveChatView s={s} userId={s.user.id} />
								)}
							</Stack>
						)}
					</Paper>
					{callPanelOpen(s) && (
						<Paper
							component="aside"
							style={{
								width: "300px",
								minWidth: "300px",
								borderRadius: 0,
								borderLeft: PANEL_BORDER,
								background: PANEL_BACKGROUND,
								padding: 8,
								overflowY: "auto",
							}}
						>
							<ActiveCallOverlay
								open={true}
								peerNick={callPeerNick(s)}
								localStream={s.call.localStream}
								remoteStream={s.call.remoteStream}
								muted={s.call.muted}
								cameraOn={s.call.cameraOn}
								onToggleMute={s.toggleCallMute}
								onToggleCamera={s.toggleCallCamera}
								onHangup={() => {
									void s.hangupCall();
								}}
							/>
						</Paper>
					)}
				</div>
				<IncomingCallOverlay
					open={s.call.phase === "incoming"}
					peerNick={callPeerNick(s)}
					onAccept={() => {
						void s.acceptCall();
					}}
					onReject={() => {
						void s.rejectCall();
					}}
				/>
				{s.call.phase === "ended" && (
					<div style={{ padding: "8px 16px" }}>
						<EndedCallNotice
							reason={s.call.reason}
							callRole={s.call.role}
							peerNick={callPeerNick(s)}
							onDismiss={s.dismissCall}
						/>
					</div>
				)}
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
