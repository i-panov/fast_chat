// The page composes every chat surface; the file is intentionally a single
// layout module.
/* eslint-disable max-lines */
import {
	ActionIcon,
	Alert,
	Button,
	Center,
	Group,
	Modal,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, CheckSquare, Pin, Settings, Trash2, X } from "lucide-react";
import type * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AccountSwitcher } from "../AccountSwitcher.tsx";
import {
	blockUser,
	deleteChat,
	getPinnedMessages,
	pinMessage,
	unpinMessage,
} from "../api.ts";
import { ActiveCallOverlay } from "../components/chat/ActiveCallOverlay.tsx";
import { AppHeader } from "../components/chat/AppHeader.tsx";
import { AudioPlayerBar } from "../components/chat/AudioPlayerBar.tsx";
import { CallButton } from "../components/chat/CallButton.tsx";
import { ChatList } from "../components/chat/ChatList.tsx";
import { CreateGroupModal } from "../components/chat/CreateGroupModal.tsx";
import { EndedCallNotice } from "../components/chat/EndedCallNotice.tsx";
import { ForwardModal } from "../components/chat/ForwardModal.tsx";
import { GroupSettingsModal } from "../components/chat/GroupSettingsModal.tsx";
import { IncomingCallSection } from "../components/chat/IncomingCallOverlay.tsx";
import { InputBar } from "../components/chat/InputBar.tsx";
import { LocationPickerModal } from "../components/chat/LocationPickerModal.tsx";
import { MessageList } from "../components/chat/MessageList.tsx";
import { MessageSearchModal } from "../components/chat/MessageSearchModal.tsx";
import { MultiDeviceKeyModal } from "../components/chat/MultiDeviceKeyModal.tsx";
import { PinnedMessagesModal } from "../components/chat/PinnedMessagesModal.tsx";
import { RecoveryModal } from "../components/chat/RecoveryModal.tsx";
import { SearchBox } from "../components/chat/SearchBox.tsx";
import { ThreadView } from "../components/chat/ThreadView.tsx";
import { ErrorBoundary } from "../components/ErrorBoundary.tsx";
import { OnlineDot } from "../components/shared/OnlineDot.tsx";
import ChatContext from "../context/ChatContext.tsx";
import {
	type MessageSelection,
	MessageSelectionProvider,
} from "../context/MessageSelectionContext.tsx";
import { chatsRepo } from "../db/chatsRepo.ts";
import { outboxRepo } from "../db/outboxRepo.ts";
import { useChatPage } from "../hooks/useChatInteraction.ts";
import { usePushNotifications } from "../hooks/usePushNotifications.ts";
import { scheduleSync } from "../sync/syncEngine.ts";
import type { Chat, Message } from "../types/api.ts";
import { chatFromPath, chatTitle, privateChatRef } from "../utils/chat.ts";
import { emitNotification } from "../utils/notify.ts";

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
	pinnedButton,
	callButton,
	onOpenSettings,
	onBack,
	selectionButton,
}: {
	title: string;
	subtitle?: string;
	badge?: string;
	typingNick?: string;
	online?: boolean;
	pinnedButton?: React.ReactNode;
	callButton?: React.ReactNode;
	onOpenSettings?: () => void;
	onBack?: () => void;
	selectionButton?: React.ReactNode;
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
			<Group justify="space-between" wrap="nowrap" gap="xs">
				{onBack !== undefined && (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={onBack}
						aria-label={t("chat.back")}
					>
						<ArrowLeft size={20} />
					</ActionIcon>
				)}
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
					{selectionButton}
					{pinnedButton}
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
	pinnedButton,
	onBack,
	onStartSelection,
}: {
	s: ChatPageState;
	userId: string;
	pinnedButton?: React.ReactNode;
	onBack?: () => void;
	onStartSelection?: () => void;
}): React.ReactElement | null {
	const { t } = useTranslation();

	const typingNicks =
		s.activeChatId !== null ? (s.typingUsers[s.activeChatId] ?? []) : [];
	const typingNick = typingNicks[0]?.nick;

	if (s.pendingChatWith !== null) {
		return (
			<ChatHeader
				title={`@${s.pendingChatNick ?? ""}`}
				badge="newChat"
				onBack={onBack}
			/>
		);
	}

	if (s.activeChat === undefined) {
		return null;
	}

	const isGroup = s.activeChat.type === "group";
	const isSelf = s.activeChat.type === "self";
	const otherMember =
		isGroup || isSelf
			? undefined
			: s.activeChat.members.find((m) => m.id !== userId);
	// A bot's display name may contain spaces; the username is the stable
	// nickname shown in the chat header, exactly like a human @nick. A
	// missing username (remote bots have no local row) falls back to the
	// display name rather than rendering "@undefined".
	const botHandle =
		s.activeChat.isBotChat === true ? otherMember?.username : undefined;
	const title = isSelf
		? chatTitle(s.activeChat, userId)
		: isGroup
			? s.activeChat.name || t("chat.groupFallback")
			: botHandle
				? `@${botHandle}`
				: `@${chatTitle(s.activeChat, userId)}`;
	const subtitle = isGroup
		? t("chat.membersCount", { count: s.activeChat.members.length })
		: s.activeChat.isBotChat === true
			? s.activeChat.botEncryptionMode === "e2ee"
				? t("chat.botE2EE")
				: t("chat.botPlaintext")
			: undefined;
	// A call that is going on keeps the button out of reach: the manager
	// refuses a second call anyway.
	const callBusy = s.call.phase !== "idle" && s.call.phase !== "ended";

	return (
		<ChatHeader
			title={title}
			subtitle={subtitle}
			pinnedButton={pinnedButton}
			typingNick={typingNick}
			onBack={onBack}
			selectionButton={
				onStartSelection !== undefined ? (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={onStartSelection}
						aria-label={t("message.select")}
					>
						<CheckSquare size={18} />
					</ActionIcon>
				) : undefined
			}
			online={isGroup || isSelf ? undefined : (otherMember?.online ?? false)}
			callButton={
				s.activeChat.isBotChat === true ? undefined : (
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
				)
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

function ChatSidebar({
	s,
	userId,
	fullWidth = false,
	onDeleteChat,
	onSelectChat,
}: {
	s: ChatPageState;
	userId: string;
	fullWidth?: boolean;
	onDeleteChat?: (chat: Chat) => void;
	onSelectChat: (chatId: string) => void;
}) {
	return (
		<Paper
			component="aside"
			style={{
				width: fullWidth ? "100%" : "300px",
				minWidth: fullWidth ? 0 : "300px",
				flex: fullWidth ? 1 : undefined,
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
					onSelectChat={onSelectChat}
					onDeleteChat={onDeleteChat}
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

function PendingChatView({
	s,
	userId,
	onBack,
}: {
	s: ChatPageState;
	userId: string;
	onBack?: () => void;
}) {
	const { t } = useTranslation();

	return (
		<>
			<ChatHeaderSlot s={s} userId={userId} onBack={onBack} />
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

// eslint-disable-next-line max-lines-per-function -- the chat view composes header, messages, selection and pin/forward dialogs.
function ActiveChatView({
	s,
	userId,
	onBack,
	scrollToMessageId,
}: {
	s: ChatPageState;
	userId: string;
	onBack?: () => void;
	scrollToMessageId?: string | null;
}) {
	const { t } = useTranslation();
	const showAuthorForGroup = s.activeChat?.type === "group";
	const [pinsOpen, setPinsOpen] = useState(false);
	const [pins, setPins] = useState<Message[]>([]);
	const [pinsLoading, setPinsLoading] = useState(false);
	const [forwarding, setForwarding] = useState<Message | null>(null);
	const [selectionMode, setSelectionMode] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
	const [bulkDeleting, setBulkDeleting] = useState(false);
	const [bulkError, setBulkError] = useState<string | null>(null);
	const chat = s.activeChat;
	const token = s.activeAccount?.token;
	const pinnedIds = new Set(chat?.pinnedMessageIds ?? []);
	const canPin =
		chat !== undefined && (chat.type !== "group" || chat.ownerId === userId);

	// biome-ignore lint/correctness/useExhaustiveDependencies: chat?.id is the reset trigger, not a value read in the effect.
	useEffect(() => {
		setSelectionMode(false);
		setSelected(new Set());
		setConfirmBulkDelete(false);
	}, [chat?.id]);

	const loadPins = useCallback(async () => {
		if (chat === undefined || token === undefined) return;
		setPinsLoading(true);
		try {
			const result = await getPinnedMessages(token, chat.id);
			setPins(result.messages);
		} finally {
			setPinsLoading(false);
		}
	}, [chat, token]);

	const openPins = useCallback(() => {
		setPinsOpen(true);
		void loadPins();
	}, [loadPins]);

	const togglePin = useCallback(
		async (chatId: string, messageId: string) => {
			if (chat === undefined || token === undefined) return;
			const pinned = chat.pinnedMessageIds?.includes(messageId) === true;
			if (typeof navigator !== "undefined" && !navigator.onLine) {
				await outboxRepo.enqueue({
					kind: "pin",
					opId: crypto.randomUUID(),
					chatId,
					messageId,
					pinned: !pinned,
					previousPinned: pinned,
					createdAt: new Date().toISOString(),
					attempts: 0,
				});
				scheduleSync();
			} else if (pinned) {
				await unpinMessage(token, chatId, messageId);
			} else {
				await pinMessage(token, chatId, messageId);
			}
			const current = chat.pinnedMessageIds ?? [];
			const next = pinned
				? current.filter((id) => id !== messageId)
				: [messageId, ...current];
			await chatsRepo.upsert({ ...chat, pinnedMessageIds: next });
			if (pinsOpen) await loadPins();
		},
		[chat, token, pinsOpen, loadPins],
	);

	const toggleSelected = useCallback((messageId: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(messageId)) next.delete(messageId);
			else next.add(messageId);

			return next;
		});
	}, []);

	const startSelection = useCallback((messageId: string) => {
		setSelectionMode(true);
		setSelected(new Set([messageId]));
	}, []);

	const clearSelection = useCallback(() => {
		setSelectionMode(false);
		setSelected(new Set());
		setBulkError(null);
	}, []);

	const selection = useMemo<MessageSelection>(
		() => ({
			mode: selectionMode,
			selected,
			toggle: toggleSelected,
			start: startSelection,
			clear: clearSelection,
		}),
		[selectionMode, selected, toggleSelected, startSelection, clearSelection],
	);

	async function deleteSelected() {
		if (chat === undefined || selected.size === 0) return;
		setBulkDeleting(true);
		setBulkError(null);
		try {
			for (const messageId of selected) {
				await s.handleDeleteMessage(chat.id, messageId);
			}
			setConfirmBulkDelete(false);
			clearSelection();
		} catch (err) {
			setBulkError(err instanceof Error ? err.message : String(err));
		} finally {
			setBulkDeleting(false);
		}
	}

	return (
		<>
			{selectionMode ? (
				<Paper
					component="header"
					style={{
						borderRadius: 0,
						background: PANEL_BACKGROUND,
						borderBottom: PANEL_BORDER,
					}}
				>
					<Group justify="space-between" px="md" py="xs" wrap="nowrap">
						<Group gap="xs" wrap="nowrap">
							<ActionIcon
								variant="subtle"
								color="gray"
								size="lg"
								onClick={clearSelection}
								aria-label={t("message.cancelSelection")}
							>
								<X size={18} />
							</ActionIcon>
							<Text fw={600} truncate>
								{t("message.selectedCount", { count: selected.size })}
							</Text>
						</Group>
						<Button
							color="red"
							size="xs"
							leftSection={<Trash2 size={14} />}
							disabled={selected.size === 0}
							onClick={() => {
								setBulkError(null);
								setConfirmBulkDelete(true);
							}}
						>
							{t("message.deleteSelected")}
						</Button>
					</Group>
				</Paper>
			) : (
				<ChatHeaderSlot
					s={s}
					userId={userId}
					onBack={onBack}
					onStartSelection={() => setSelectionMode(true)}
					pinnedButton={
						canPin ? (
							<ActionIcon
								variant="subtle"
								color="gray"
								size="lg"
								onClick={openPins}
								aria-label={t("pins.open")}
							>
								<Pin size={18} />
								{pinnedIds.size > 0 && (
									<Text size="xs" style={{ marginLeft: 2 }}>
										{pinnedIds.size}
									</Text>
								)}
							</ActionIcon>
						) : undefined
					}
				/>
			)}
			<MessageSelectionProvider value={selection}>
				<MessageList
					key={s.activeChatId ?? "none"}
					messages={s.activeMessages}
					userId={userId}
					chatId={s.activeChatId}
					token={s.activeAccount?.token}
					onDelete={s.handleDeleteMessage}
					onStartEdit={s.handleStartEdit}
					onReply={s.handleReply}
					scrollToMessageId={scrollToMessageId}
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
					onPin={(chatId, messageId) => {
						void togglePin(chatId, messageId);
					}}
					onBlock={(fromId) => {
						if (token !== undefined) void blockUser(token, fromId);
					}}
					onForward={(_, messageId) => {
						const message = s.activeMessages.find((m) => m.id === messageId);
						if (message !== undefined) setForwarding(message);
					}}
					pinnedIds={pinnedIds}
					showAuthorForGroup={showAuthorForGroup}
					isOffline={!s.isOnline}
				/>
			</MessageSelectionProvider>
			<Modal
				opened={confirmBulkDelete}
				onClose={() => {
					if (!bulkDeleting) setConfirmBulkDelete(false);
				}}
				title={t("message.deleteSelectedTitle")}
				centered
				size="sm"
			>
				<Stack gap="md">
					<Text size="sm">
						{t("message.deleteSelectedConfirm", { count: selected.size })}
					</Text>
					{bulkError !== null && <Alert color="red">{bulkError}</Alert>}
					<Group justify="flex-end">
						<Button
							variant="default"
							disabled={bulkDeleting}
							onClick={() => setConfirmBulkDelete(false)}
						>
							{t("input.cancel")}
						</Button>
						<Button
							color="red"
							loading={bulkDeleting}
							onClick={() => {
								void deleteSelected();
							}}
						>
							{t("message.deleteSelected")}
						</Button>
					</Group>
				</Stack>
			</Modal>
			<ForwardModal
				open={forwarding !== null}
				onClose={() => setForwarding(null)}
				chats={s.chats}
				userId={userId}
				message={forwarding}
				onForward={(targetChatId) => {
					if (forwarding !== null) {
						void s.handleForwardMessage(targetChatId, forwarding);
					}
					setForwarding(null);
				}}
			/>
			<PinnedMessagesModal
				open={pinsOpen}
				onClose={() => setPinsOpen(false)}
				loading={pinsLoading}
				messages={pins}
				canUnpin={canPin}
				onUnpin={(messageId) => {
					void togglePin(s.activeChatId ?? "", messageId);
				}}
			/>
			<ChatInputBar s={s} withTyping />
		</>
	);
}

// eslint-disable-next-line max-lines-per-function -- the page owns the layout, routing and call windows in one place.
export function ChatPage() {
	const s = useChatPage();
	const { selectChat, handleOpenThread } = s;
	const { t } = useTranslation();
	const isMobile = useMediaQuery("(max-width: 48em)") === true;
	const [messageSearchOpen, setMessageSearchOpen] = useState(false);
	const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(
		null,
	);
	const [chatToDelete, setChatToDelete] = useState<Chat | null>(null);
	const [deletingChat, setDeletingChat] = useState(false);

	usePushNotifications(s.activeAccount?.token ?? "");

	const navigate = useNavigate();
	const deleteToken = s.activeAccount?.token;
	const currentChatId = s.activeChatId;
	const selectChatState = s.selectChat;
	const activeThread = s.activeThread;
	const closeThread = s.handleCloseThread;
	const cancelPendingChat = s.cancelPendingChat;

	const confirmDeleteChat = useCallback(async () => {
		if (chatToDelete === null || deleteToken === undefined) return;
		setDeletingChat(true);
		try {
			await deleteChat(deleteToken, chatToDelete.id);
			// The SSE event does the same, but removing locally makes the row
			// disappear even when the event is delayed.
			await chatsRepo.remove(chatToDelete.id);
			if (currentChatId === chatToDelete.id) {
				selectChatState(null);
				void navigate({
					to: "/chat",
					search: { chatId: undefined, threadId: undefined },
					replace: true,
				});
			}
			setChatToDelete(null);
		} catch {
			emitNotification(t("chat.deleteChatFailed"));
		} finally {
			setDeletingChat(false);
		}
	}, [chatToDelete, deleteToken, currentChatId, selectChatState, t, navigate]);

	const mobileChatOpen =
		isMobile &&
		(s.activeChat !== undefined ||
			s.pendingChatWith !== null ||
			s.activeThread !== null);

	const closeMobileChat = useCallback(() => {
		if (activeThread !== null) {
			closeThread();
			return;
		}
		cancelPendingChat();
		selectChatState(null);
		void navigate({
			to: "/chat",
			search: { chatId: undefined, threadId: undefined },
			replace: true,
		});
	}, [activeThread, closeThread, cancelPendingChat, selectChatState, navigate]);

	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	// A selection may come from a hook that does not know the router
	// (creating a group, starting a chat from search). The effect below writes
	// its canonical path once; openChat marks the chat it is already opening,
	// so a click does not produce a second history entry.
	const lastOpenedChatRef = useRef<string | null>(null);

	const navigateToChat = useCallback(
		(chat: Chat, replace = false) => {
			lastOpenedChatRef.current = chat.id;
			if (chat.type === "self") {
				void navigate({ to: "/favorite", replace });
			} else if (chat.type === "group") {
				void navigate({
					to: "/group/$groupId",
					params: { groupId: chat.id },
					replace,
				});
			} else {
				void navigate({
					to: "/chat/$chatRef",
					params: { chatRef: privateChatRef(chat, s.user?.id ?? "") },
					search: { chatId: undefined, threadId: undefined },
					replace,
				});
			}
		},
		[navigate, s.user?.id],
	);

	const openChat = useCallback(
		(chatId: string) => {
			selectChat(chatId);
			// A pending jump belongs to the chat that requested it; a manual
			// switch must not inherit a stale target.
			setScrollToMessageId(null);
			const chat = s.chats.find((c) => c.id === chatId);
			if (chat !== undefined) {
				navigateToChat(chat);
			}
		},
		[selectChat, s.chats, navigateToChat],
	);

	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		function handleMessage(event: MessageEvent) {
			const data = event.data as {
				type?: string;
				chatId?: string;
				threadId?: string;
			};
			if (data.type !== "NAVIGATE_TO_CHAT") return;
			if (typeof data.chatId !== "string") return;

			openChat(data.chatId);

			if (typeof data.threadId === "string") {
				handleOpenThread(data.threadId);
			}
		}

		const sw = navigator.serviceWorker;
		sw.addEventListener("message", handleMessage);

		return () => {
			sw.removeEventListener("message", handleMessage);
		};
	}, [openChat, handleOpenThread]);

	// The address is the source of truth: /chat/<user>, /group/<id> and
	// /favorite select a chat, /chat shows the list. Waiting for the sync is
	// intentional: an unknown reference must not clear a valid selection.
	// Going back to /chat clears the selection; the first render of /chat does
	// not, because a selection can be set before its path is written.
	const previousPathRef = useRef(pathname);
	useEffect(() => {
		const chat = chatFromPath(pathname, s.chats, s.user?.id ?? "");
		if (chat !== undefined) {
			if (chat.id !== s.activeChatId) selectChat(chat.id);
		} else if (pathname === "/chat" && previousPathRef.current !== "/chat") {
			selectChat(null);
		}
		previousPathRef.current = pathname;
	}, [pathname, s.chats, s.user?.id, s.activeChatId, selectChat]);

	// Selection made outside openChat (a new group, a chat started from the
	// search) still has to appear in the address bar.
	useEffect(() => {
		if (pathname !== "/chat" || s.activeChatId === null) return;
		if (lastOpenedChatRef.current === s.activeChatId) return;
		const chat = s.chats.find((c) => c.id === s.activeChatId);
		if (chat !== undefined) navigateToChat(chat, true);
	}, [pathname, s.activeChatId, s.chats, navigateToChat]);

	// Leaving or deleting a group clears the selection while the address still
	// names the group; go back to the list instead of keeping a dead link.
	const previousActiveChatRef = useRef<string | null>(null);
	useEffect(() => {
		if (
			previousActiveChatRef.current !== null &&
			s.activeChatId === null &&
			pathname !== "/chat"
		) {
			void navigate({
				to: "/chat",
				search: { chatId: undefined, threadId: undefined },
				replace: true,
			});
		}
		previousActiveChatRef.current = s.activeChatId;
	}, [s.activeChatId, pathname, navigate]);

	// Legacy links used ?chatId=; consume them once and move to the canonical
	// path so the address stays shareable.
	const legacyChatId = new URLSearchParams(window.location.search).get(
		"chatId",
	);
	useEffect(() => {
		if (legacyChatId === null) return;
		const chat = s.chats.find((c) => c.id === legacyChatId);
		if (chat === undefined) return;

		const threadId = new URLSearchParams(window.location.search).get(
			"threadId",
		);
		selectChat(chat.id);
		navigateToChat(chat, true);

		const params = new URLSearchParams(window.location.search);
		params.delete("chatId");
		params.delete("threadId");
		const clean = params.toString();
		const base = window.location.pathname;
		window.history.replaceState({}, "", clean ? `${base}?${clean}` : base);

		if (threadId) {
			handleOpenThread(threadId);
		}
	}, [legacyChatId, s.chats, selectChat, navigateToChat, handleOpenThread]);

	if (s.activeAccount === null || s.user === null) {
		return null;
	}

	return (
		<ChatContext.Provider value={s}>
			<Stack h="100%" gap={0}>
				<MultiDeviceKeyModal activeToken={s.activeAccount?.token ?? null} />
				<MessageSearchModal
					open={messageSearchOpen}
					onClose={() => setMessageSearchOpen(false)}
					userId={s.user.id}
					onSelect={(chatId, messageId) => {
						openChat(chatId);
						setScrollToMessageId(messageId);
					}}
				/>
				<AccountSwitcher
					open={s.switcherOpen}
					onClose={() => s.setSwitcherOpen(false)}
					onLogout={s.logout}
				/>
				<RecoveryModal activeToken={s.activeAccount?.token ?? null} />
				<AppHeader
					onSwitcherToggle={() => s.setSwitcherOpen(true)}
					onOpenMessageSearch={() => setMessageSearchOpen(true)}
				/>
				<AudioPlayerBar />
				<div style={{ display: "flex", flex: 1, minHeight: 0 }}>
					{(!isMobile || !mobileChatOpen) && (
						<ErrorBoundary>
							<ChatSidebar
								s={s}
								userId={s.user.id}
								fullWidth={isMobile}
								onDeleteChat={setChatToDelete}
								onSelectChat={openChat}
							/>
						</ErrorBoundary>
					)}
					{(!isMobile || mobileChatOpen) && (
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
										<PendingChatView
											s={s}
											userId={s.user.id}
											onBack={isMobile ? closeMobileChat : undefined}
										/>
									) : s.activeChat === undefined ? (
										<Center style={{ flex: 1 }}>
											<Text ta="center" c="dimmed" size="sm">
												{t("chat.selectPrompt")}
											</Text>
										</Center>
									) : (
										<ActiveChatView
											s={s}
											userId={s.user.id}
											scrollToMessageId={scrollToMessageId}
											onBack={isMobile ? closeMobileChat : undefined}
										/>
									)}
								</Stack>
							)}
						</Paper>
					)}
					{callPanelOpen(s) && (
						<Paper
							component="aside"
							style={
								isMobile
									? {
											position: "fixed",
											inset: "48px 0 0",
											zIndex: 300,
											borderRadius: 0,
											background: PANEL_BACKGROUND,
											padding: 8,
											overflowY: "auto",
										}
									: {
											width: "300px",
											minWidth: "300px",
											borderRadius: 0,
											borderLeft: PANEL_BORDER,
											background: PANEL_BACKGROUND,
											padding: 8,
											overflowY: "auto",
										}
							}
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
				<IncomingCallSection s={s} peerNick={callPeerNick(s)} />
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
				<Modal
					opened={chatToDelete !== null}
					onClose={() => {
						if (!deletingChat) setChatToDelete(null);
					}}
					title={t("chat.deleteChatTitle")}
				>
					<Stack gap="md">
						<Text size="sm">
							{t("chat.deleteChatConfirm", {
								title:
									chatToDelete === null
										? ""
										: chatTitle(chatToDelete, s.user.id),
							})}
						</Text>
						<Group justify="flex-end" gap="xs">
							<Button
								variant="default"
								disabled={deletingChat}
								onClick={() => setChatToDelete(null)}
							>
								{t("accounts.cancel")}
							</Button>
							<Button
								color="red"
								loading={deletingChat}
								onClick={() => {
									void confirmDeleteChat();
								}}
							>
								{t("chat.deleteChat")}
							</Button>
						</Group>
					</Stack>
				</Modal>
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
