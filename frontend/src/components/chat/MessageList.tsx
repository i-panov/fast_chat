import { Loader, Text } from "@mantine/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

function flashElement(el: Element) {
	const flashClass = "bubble-flash";
	el.classList.remove(flashClass);
	void el.getBoundingClientRect();
	el.classList.add(flashClass);
	window.setTimeout(() => {
		el.classList.remove(flashClass);
	}, 1500);
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
	messageToThread?: Record<string, string>;
	threads?: Record<string, Thread>;
	isInThread?: boolean;
	onRetry?: (chatId: string, messageId: string) => void | Promise<void>;
	onCancelSend?: (chatId: string, messageId: string) => void;
	scrollToMessageId?: string | null;
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
		const showAuthor =
			showAuthorForGroup === true &&
			(prev === undefined || prev.fromId !== msg.fromId);
		result.push({
			type: "message",
			key: msg.id,
			showAuthor,
			msg,
		});
	}
	return result;
}

function scrollToReplyMessage(
	prevScrollToRef: { current: string | null },
	messageId: string,
) {
	prevScrollToRef.current = messageId;
	const el = document.querySelector(`[data-message-id="${messageId}"]`);
	if (el !== null) {
		el.scrollIntoView({ behavior: "smooth", block: "center" });
		flashElement(el);
	}
}

function scrollToMessageInRange(args: {
	range: { startIndex: number; endIndex: number };
	datedMessages: DatedEntry[];
	scrollToMessageId?: string | null;
	prevScrollToRef: { current: string | null };
	virtuosoRef: { current: VirtuosoHandle | null };
}) {
	const {
		range,
		datedMessages,
		scrollToMessageId,
		prevScrollToRef,
		virtuosoRef,
	} = args;
	if (scrollToMessageId === undefined || scrollToMessageId === null) return;
	if (scrollToMessageId === prevScrollToRef.current) return;
	const idx = datedMessages.findIndex(
		(e) => e.type === "message" && e.msg.id === scrollToMessageId,
	);
	if (idx === -1) return;
	if (idx >= range.startIndex && idx <= range.endIndex) {
		prevScrollToRef.current = scrollToMessageId;
		virtuosoRef.current?.scrollToIndex({ index: idx, align: "center" });
		const el = document.querySelector(
			`[data-message-id="${scrollToMessageId}"]`,
		);
		if (el !== null) flashElement(el);
	}
}

function EmptyState({ isOffline }: { isOffline?: boolean }) {
	const { t } = useTranslation();
	return (
		<div
			style={{
				flex: 1,
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

function MessageEntry(props: {
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
	messageToThread?: Record<string, string>;
	threads?: Record<string, Thread>;
	isInThread?: boolean;
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
		messageToThread,
		threads,
		isInThread,
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
				time={formatTime(msg.createdAt, locale)}
				chatId={msg.chatId}
				msgId={msg.id}
				editedAt={msg.editedAt}
				replyTo={msg.replyTo}
				files={msg.files}
				location={msg.location}
				onReplyClick={onReplyClick}
				onStartEdit={onStartEdit}
				onDelete={onDelete}
				onReply={onReply}
				editTTL={editTTL}
				deleteTTL={deleteTTL}
				createdAt={msg.createdAt}
				onCreateThread={onCreateThread}
				onOpenThread={onOpenThread}
				threadId={messageToThread?.[msg.id]}
				threadMessageCount={
					messageToThread?.[msg.id] !== undefined
						? threads?.[messageToThread[msg.id]]?.messageCount
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
			/>
		</div>
	);
}

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
	messageToThread,
	threads,
	isInThread,
	onRetry,
	onCancelSend,
	scrollToMessageId,
	showAuthorForGroup,
	isOffline,
}: Props) {
	const locale = getCurrentLocale();
	const virtuosoRef = useRef<VirtuosoHandle>(null);
	const onLoadMoreRef = useRef(onLoadMore);
	const prevScrollToRef = useRef<string | null>(null);
	const [visibleRange, setVisibleRange] = useState<{
		startIndex: number;
		endIndex: number;
	}>({ startIndex: 0, endIndex: 0 });

	const { markVisibleAsRead } = useMessageReadStatuses({
		token,
		chatId,
		isInThread,
	});

	const handleReplyClick = useCallback(
		(messageId: string) => scrollToReplyMessage(prevScrollToRef, messageId),
		[],
	);

	const datedMessages = useMemo(
		() => buildDatedMessages(messages, locale, showAuthorForGroup),
		[messages, locale, showAuthorForGroup],
	);

	// Track visible messages and mark them as read. Already-read
	// messages are skipped so the POST → local markAsRead → re-render
	// cycle cannot loop.
	useEffect(() => {
		if (visibleRange.startIndex === 0 && visibleRange.endIndex === 0) return;

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
				messageToThread={messageToThread}
				threads={threads}
				isInThread={isInThread}
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
			messageToThread,
			threads,
			isInThread,
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
			style={{ flex: 1 }}
			data={datedMessages}
			itemContent={itemContent}
			followOutput="smooth"
			initialTopMostItemIndex={datedMessages.length - 1}
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
				scrollToMessageInRange({
					range,
					datedMessages,
					scrollToMessageId,
					prevScrollToRef,
					virtuosoRef,
				});
			}}
		/>
	);
}
