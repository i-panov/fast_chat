import { Loader, Text } from "@mantine/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { useMessageReadStatuses } from "../../hooks/useMessageReadStatuses.ts";
import { getCurrentLocale } from "../../i18n.ts";
import type { FileInfo, Message, Thread } from "../../types/api.ts";
import { formatDateLabel, formatTime } from "../../utils/chat.ts";
import { collectVisibleUnreadIds } from "../../utils/messageRead.ts";
import { MessageBubble } from "./MessageBubble.tsx";

function DateSeparator({ dateStr }: { dateStr: string }) {
	return (
		<Text ta="center" size="xs" c="dimmed" py={6}>
			{formatDateLabel(dateStr)}
		</Text>
	);
}

function LoadingHeader() {
	const { t } = useTranslation();
	return (
		<div
			style={{
				display: "flex",
				justifyContent: "center",
				alignItems: "center",
				gap: 6,
				padding: "6px 0 2px",
			}}
		>
			<Loader size="xs" type="dots" />
			<Text component="span" size="xs" c="dimmed">
				{t("chat.loading")}
			</Text>
		</div>
	);
}

const flashTimers = new WeakMap<Element, number>();

function flashElement(el: Element) {
	const flashClass = "bubble-flash";
	const prev = flashTimers.get(el);
	if (prev !== undefined) clearTimeout(prev);
	el.classList.remove(flashClass);
	void el.getBoundingClientRect();
	el.classList.add(flashClass);
	const id = window.setTimeout(() => {
		el.classList.remove(flashClass);
		flashTimers.delete(el);
	}, 1500);
	flashTimers.set(el, id);
}

function queryMessageElement(messageId: string): Element | null {
	try {
		const escaped =
			typeof CSS !== "undefined" && typeof CSS.escape === "function"
				? CSS.escape(messageId)
				: messageId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return document.querySelector(`[data-message-id="${escaped}"]`);
	} catch {
		return null;
	}
}

interface Props {
	messages: Message[];
	userId: string;
	chatId: string | null;
	token: string | undefined;
	onDelete: (chatId: string, messageId: string) => void | Promise<void>;
	onStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	onReply?: (chatId: string, messageId: string) => void;
	editTTL: number;
	deleteTTL: number;
	hasMore?: boolean;
	isLoadingMore?: boolean;
	onLoadMore?: () => void;
	onCreateThread?: (chatId: string, messageId: string) => void;
	onOpenThread?: (threadId: string) => void;
	onPin?: (chatId: string, messageId: string) => void;
	onBlock?: (fromId: string) => void;
	onForward?: (chatId: string, messageId: string) => void;
	pinnedIds?: Set<string>;
	messageToThread?: Record<string, string>;
	threads?: Record<string, Thread>;
	isInThread?: boolean;
	// threadId is the thread that contains the listed messages (ThreadView).
	// It addresses edit/reaction storage; messageToThread only links a parent
	// message to the thread it started.
	threadId?: string;
	onRetry?: (chatId: string, messageId: string) => void | Promise<void>;
	onCancelSend?: (chatId: string, messageId: string) => void;
	scrollToMessageId?: string | null;
	scrollToMessageNonce?: number;
	showAuthorForGroup?: boolean;
	isOffline?: boolean;
}

type DatedEntry = {
	type: "separator" | "message";
	key: string;
	showAuthor: boolean;
	msg: Message;
};

function buildDatedMessages(
	messages: Message[],
	locale: string,
	showAuthorForGroup?: boolean,
): DatedEntry[] {
	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	let lastDateKey = "";
	const result: DatedEntry[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const dateKey = new Date(msg.createdAt).toLocaleDateString(locale, fmt);
		const showSeparator = dateKey !== lastDateKey;
		lastDateKey = dateKey;
		if (showSeparator) {
			result.push({
				type: "separator",
				key: `sep-${dateKey}`,
				showAuthor: false,
				msg,
			});
		}
		const prev = i > 0 ? messages[i - 1] : undefined;
		// A date separator breaks the author run: the first message of a new
		// day needs its nick even when the same person wrote the last one
		// yesterday.
		const showAuthor =
			showAuthorForGroup === true &&
			(showSeparator || prev === undefined || prev.fromId !== msg.fromId);
		result.push({
			type: "message",
			key: msg.id,
			showAuthor,
			msg,
		});
	}
	return result;
}

function flashMessageElement(messageId: string) {
	// Virtuoso mounts the row asynchronously; flash it after the jump.
	requestAnimationFrame(() => {
		const el = queryMessageElement(messageId);
		if (el !== null) flashElement(el);
	});
}

// jumpToMessage scrolls to the message when its row is already loaded.
// It returns false when the row is missing, so a request can be retried after
// a history page arrives.
function jumpToMessage(
	datedMessages: DatedEntry[],
	virtuosoRef: { current: VirtuosoHandle | null },
	messageId: string,
): boolean {
	const idx = datedMessages.findIndex(
		(e) => e.type === "message" && e.msg.id === messageId,
	);
	if (idx === -1) return false;
	virtuosoRef.current?.scrollToIndex({ index: idx, align: "center" });
	flashMessageElement(messageId);
	return true;
}

// Virtuoso needs a decreasing firstItemIndex when a page is prepended,
// otherwise the viewport jumps to a different message after loadMore.
const INITIAL_ITEM_INDEX = 100_000;

function useFirstItemIndex(entries: DatedEntry[]): number {
	const [state, setState] = useState<{
		firstMessageId: string | null;
		length: number;
		index: number;
	}>({ firstMessageId: null, length: 0, index: INITIAL_ITEM_INDEX });

	const firstMessage = entries.find((e) => e.type === "message");
	if (firstMessage === undefined) {
		if (state.firstMessageId !== null) {
			setState({ firstMessageId: null, length: 0, index: state.index });
		}
		return state.index;
	}
	const firstId = firstMessage.msg.id;
	// The date separator of the previous first row may be shared by the
	// prepended page, so the shift is detected by the first message id.
	if (
		state.firstMessageId !== null &&
		firstId !== state.firstMessageId &&
		entries.some(
			(e) => e.type === "message" && e.msg.id === state.firstMessageId,
		)
	) {
		const index = state.index - (entries.length - state.length);
		setState({ firstMessageId: firstId, length: entries.length, index });
		return index;
	}
	if (firstId !== state.firstMessageId || entries.length !== state.length) {
		setState({
			firstMessageId: firstId,
			length: entries.length,
			index: state.index,
		});
	}
	return state.index;
}

function EmptyState({ isOffline }: { isOffline?: boolean }) {
	const { t } = useTranslation();
	return (
		<div
			style={{
				flex: 1,
				minHeight: 0,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
		>
			<Text ta="center" c="dimmed" size="sm">
				{isOffline ? t("chat.offlineNoMessages") : t("chat.noMessages")}
			</Text>
		</div>
	);
}

const MessageEntry = memo(function MessageEntry(props: {
	entry: DatedEntry;
	userId: string;
	locale: string;
	onReplyClick: (messageId: string) => void;
	onStartEdit: Props["onStartEdit"];
	onDelete: Props["onDelete"];
	onReply?: Props["onReply"];
	editTTL: number;
	deleteTTL: number;
	onCreateThread?: Props["onCreateThread"];
	onOpenThread?: Props["onOpenThread"];
	onPin?: Props["onPin"];
	onBlock?: Props["onBlock"];
	onForward?: Props["onForward"];
	pinnedIds?: Set<string>;
	messageToThread?: Record<string, string>;
	threads?: Record<string, Thread>;
	isInThread?: boolean;
	threadId?: string;
	onRetry?: Props["onRetry"];
	onCancelSend?: Props["onCancelSend"];
}) {
	const {
		entry,
		userId,
		locale,
		onReplyClick,
		onStartEdit,
		onDelete,
		onReply,
		editTTL,
		deleteTTL,
		onCreateThread,
		onOpenThread,
		onPin,
		onBlock,
		onForward,
		pinnedIds,
		messageToThread,
		threads,
		isInThread,
		threadId,
		onRetry,
		onCancelSend,
	} = props;
	if (entry.type === "separator") {
		return (
			<div style={{ textAlign: "center", padding: "6px 0 8px" }}>
				<DateSeparator dateStr={entry.msg.createdAt} />
			</div>
		);
	}
	const msg = entry.msg;
	const isOwn = msg.fromId === userId;
	const linkThreadId = messageToThread?.[msg.id];
	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: isOwn ? "flex-end" : "flex-start",
				padding: "0 12px 20px",
			}}
		>
			<MessageBubble
				text={msg.text}
				isOwn={isOwn}
				fromNick={msg.fromNick}
				fromId={msg.fromId}
				time={formatTime(msg.createdAt, locale)}
				chatId={msg.chatId}
				msgId={msg.id}
				editedAt={msg.editedAt}
				replyTo={msg.replyTo}
				files={msg.files}
				location={msg.location}
				reactions={msg.reactions}
				onPin={onPin}
				onBlock={onBlock}
				onForward={onForward}
				isPinned={pinnedIds?.has(msg.id) === true}
				onReplyClick={onReplyClick}
				onStartEdit={onStartEdit}
				onDelete={onDelete}
				onReply={onReply}
				editTTL={editTTL}
				deleteTTL={deleteTTL}
				createdAt={msg.createdAt}
				onCreateThread={onCreateThread}
				onOpenThread={onOpenThread}
				linkThreadId={linkThreadId}
				messageThreadId={isInThread === true ? threadId : undefined}
				threadMessageCount={
					linkThreadId !== undefined
						? threads?.[linkThreadId]?.messageCount
						: undefined
				}
				isInThread={isInThread}
				status={msg.status}
				deliveryStatus={msg.deliveryStatus}
				onRetry={onRetry}
				onCancelSend={onCancelSend}
				showAuthorNick={entry.showAuthor}
				encrypted={msg.encrypted}
				undecryptable={msg.undecryptable}
				fileKeys={msg.fileKeys}
				replyMarkup={msg.replyMarkup}
			/>
		</div>
	);
});

export function MessageList({
	messages,
	userId,
	chatId,
	token,
	onDelete,
	onStartEdit,
	onReply,
	editTTL,
	deleteTTL,
	hasMore,
	isLoadingMore,
	onLoadMore,
	onCreateThread,
	onOpenThread,
	onPin,
	onBlock,
	onForward,
	pinnedIds,
	messageToThread,
	threads,
	isInThread,
	threadId,
	onRetry,
	onCancelSend,
	scrollToMessageId,
	scrollToMessageNonce,
	showAuthorForGroup,
	isOffline,
}: Props) {
	const locale = getCurrentLocale();
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const onLoadMoreRef = useRef(onLoadMore);
	useEffect(() => {
		onLoadMoreRef.current = onLoadMore;
	}, [onLoadMore]);
	const handledScrollRef = useRef<string | null>(null);
	const [visibleRange, setVisibleRange] = useState<{
		startIndex: number;
		endIndex: number;
	}>({ startIndex: -1, endIndex: -1 });

	const { markVisibleAsRead } = useMessageReadStatuses({
		token,
		chatId,
		isInThread,
	});

	const datedMessages = useMemo(
		() => buildDatedMessages(messages, locale, showAuthorForGroup),
		[messages, locale, showAuthorForGroup],
	);
	const firstItemIndex = useFirstItemIndex(datedMessages);

	const handleReplyClick = useCallback(
		(messageId: string) => {
			jumpToMessage(datedMessages, virtuosoRef, messageId);
		},
		[datedMessages],
	);

	// A nonce distinguishes two requests for the same message: the parent
	// resets the id to null and sets it again in one batch, which would not
	// produce a state change on its own.
	const scrollRequestKey =
		scrollToMessageId === undefined || scrollToMessageId === null
			? null
			: `${scrollToMessageNonce ?? 0}:${scrollToMessageId}`;

	const tryScrollToRequest = useCallback(() => {
		if (scrollRequestKey === null || scrollToMessageId == null) {
			handledScrollRef.current = null;
			return;
		}
		if (handledScrollRef.current === scrollRequestKey) return;
		// The row may not be in the loaded page yet: leave the request
		// unmarked so rangeChanged can retry after a history page arrives.
		if (jumpToMessage(datedMessages, virtuosoRef, scrollToMessageId)) {
			handledScrollRef.current = scrollRequestKey;
		}
	}, [scrollRequestKey, scrollToMessageId, datedMessages]);

	useEffect(() => {
		tryScrollToRequest();
	}, [tryScrollToRequest]);

	// Track visible messages and mark them as read. Already-read
	// messages are skipped so the POST → local markAsRead → re-render
	// cycle cannot loop.
	useEffect(() => {
		if (visibleRange.startIndex < 0 || visibleRange.endIndex < 0) return;

		const visibleIds = collectVisibleUnreadIds(
			datedMessages,
			visibleRange.startIndex,
			visibleRange.endIndex,
			userId,
		);

		if (visibleIds.length > 0) {
			markVisibleAsRead(visibleIds);
		}
	}, [visibleRange, datedMessages, userId, markVisibleAsRead]);

	const itemContent = useCallback(
		(_index: number, entry: DatedEntry) => (
			<MessageEntry
				entry={entry}
				userId={userId}
				locale={locale}
				onReplyClick={handleReplyClick}
				onStartEdit={onStartEdit}
				onDelete={onDelete}
				onReply={onReply}
				editTTL={editTTL}
				deleteTTL={deleteTTL}
				onCreateThread={onCreateThread}
				onOpenThread={onOpenThread}
				onPin={onPin}
				onBlock={onBlock}
				onForward={onForward}
				pinnedIds={pinnedIds}
				messageToThread={messageToThread}
				threads={threads}
				isInThread={isInThread}
				threadId={threadId}
				onRetry={onRetry}
				onCancelSend={onCancelSend}
			/>
		),
		[
			userId,
			locale,
			onStartEdit,
			handleReplyClick,
			onDelete,
			onReply,
			editTTL,
			deleteTTL,
			onCreateThread,
			onOpenThread,
			onPin,
			onBlock,
			onForward,
			pinnedIds,
			messageToThread,
			threads,
			isInThread,
			threadId,
			onRetry,
			onCancelSend,
		],
	);

	if (messages.length === 0) {
		return <EmptyState isOffline={isOffline} />;
	}

	return (
		<Virtuoso
			ref={virtuosoRef}
			style={{ flex: 1, minHeight: 0 }}
			data={datedMessages}
			itemContent={itemContent}
			followOutput="auto"
			firstItemIndex={firstItemIndex}
			initialTopMostItemIndex={firstItemIndex + datedMessages.length - 1}
			startReached={() => {
				if (hasMore && !isLoadingMore) {
					onLoadMoreRef.current?.();
				}
			}}
			components={{
				Header: isLoadingMore === true ? LoadingHeader : undefined,
			}}
			rangeChanged={(range) => {
				setVisibleRange({
					startIndex: range.startIndex,
					endIndex: range.endIndex,
				});
				tryScrollToRequest();
			}}
		/>
	);
}
