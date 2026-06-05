import { Loader, Text } from "@mantine/core";
import { Fragment, useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo, Message, Thread } from "../../api.ts";
import { formatDateLabel, formatTime } from "../../utils/chat.ts";
import { MessageBubble } from "./MessageBubble.tsx";

function DateSeparator({ dateStr }: { dateStr: string }) {
	return (
		<Text ta="center" size="xs" c="dimmed" py={6}>
			{formatDateLabel(dateStr)}
		</Text>
	);
}

function flashElement(el: HTMLElement) {
	el.classList.remove("bubble-flash");
	void el.offsetWidth;
	el.classList.add("bubble-flash");
	window.setTimeout(() => {
		el.classList.remove("bubble-flash");
	}, 1500);
}

interface Props {
	messages: Message[];
	userId: string;
	onDelete: (chatId: string, messageId: string) => void;
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
	onRetry?: (chatId: string, messageId: string) => void;
	scrollToMessageId?: string | null;
	showAuthorForGroup?: boolean;
}

export function MessageList({
	messages,
	userId,
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
	scrollToMessageId,
	showAuthorForGroup,
}: Props) {
	const handleStartEdit = useCallback(
		(
			chatId: string,
			messageId: string,
			text: string,
			files?: FileInfo[],
			threadId?: string,
		) => {
			onStartEdit(chatId, messageId, text, files, threadId);
		},
		[onStartEdit],
	);
	const { t, i18n } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const scrollAnchorRef = useRef(0);
	const prevScrollToRef = useRef<string | null>(null);
	const onLoadMoreRef = useRef(onLoadMore);

	const locale = i18n.language.split("-")[0];

	// Обновляем ref при изменении onLoadMore
	useEffect(() => {
		onLoadMoreRef.current = onLoadMore;
	}, [onLoadMore]);

	useEffect(() => {
		const el = sentinelRef.current;
		if (!el || !hasMore || isLoadingMore) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting && onLoadMoreRef.current) {
					const container = containerRef.current;
					if (container) {
						scrollAnchorRef.current =
							container.scrollHeight - container.scrollTop;
					}
					onLoadMoreRef.current();
				}
			},
			{ rootMargin: "200px 0px" },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, isLoadingMore]);

	useEffect(() => {
		if (!isLoadingMore && scrollAnchorRef.current > 0) {
			const container = containerRef.current;
			if (container) {
				container.scrollTop = container.scrollHeight - scrollAnchorRef.current;
			}
			scrollAnchorRef.current = 0;
		}
	}, [isLoadingMore]);

	useEffect(() => {
		if (
			scrollToMessageId === undefined ||
			scrollToMessageId === null ||
			scrollToMessageId === prevScrollToRef.current
		)
			return;

		prevScrollToRef.current = scrollToMessageId;

		const el = containerRef.current?.querySelector(
			`[data-message-id="${scrollToMessageId}"]`,
		);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			flashElement(el as HTMLElement);
		}
	}, [scrollToMessageId]);

	const handleReplyClick = useCallback((messageId: string) => {
		prevScrollToRef.current = messageId;
		const el = containerRef.current?.querySelector(
			`[data-message-id="${messageId}"]`,
		);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "center" });
			flashElement(el as HTMLElement);
		}
	}, []);

	const datedMessages = useMemo(() => {
		const fmt: Intl.DateTimeFormatOptions = {
			day: "2-digit",
			month: "2-digit",
			year: "numeric",
		};
		let lastDateKey = "";
		return messages.map((msg) => {
			const dateKey = new Date(msg.createdAt).toLocaleDateString(locale, fmt);
			const showSeparator = dateKey !== lastDateKey;
			lastDateKey = dateKey;
			return { msg, showSeparator };
		});
	}, [messages, locale]);

	if (messages.length === 0) {
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
					{t("chat.noMessages")}
				</Text>
			</div>
		);
	}

	return (
		<div
			ref={containerRef}
			style={{
				flex: 1,
				overflowY: "auto",
				padding: "var(--mantine-spacing-md)",
			}}
		>
			{isLoadingMore && (
				<Text ta="center" size="xs" c="dimmed" py={4}>
					<Loader size="xs" type="dots" />
					{t("chat.loading")}
				</Text>
			)}
			<div ref={sentinelRef} style={{ height: 1 }} />
			<div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
				{datedMessages.map(({ msg, showSeparator }, idx) => {
					const prev = idx > 0 ? datedMessages[idx - 1].msg : undefined;
					const showAuthor =
						showAuthorForGroup === true &&
						(prev === undefined || prev.fromId !== msg.fromId);
					return (
						<Fragment key={msg.id}>
							{showSeparator && <DateSeparator dateStr={msg.createdAt} />}
							<MessageBubble
								text={msg.text}
								isOwn={msg.fromId === userId}
								fromNick={msg.fromNick}
								time={formatTime(msg.createdAt, locale)}
								chatId={msg.chatId}
								msgId={msg.id}
								editedAt={msg.editedAt}
								replyTo={msg.replyTo}
								files={msg.files}
								location={msg.location}
								onReplyClick={handleReplyClick}
								onStartEdit={handleStartEdit}
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
								onRetry={onRetry}
								showAuthorNick={showAuthor}
							/>
						</Fragment>
					);
				})}
			</div>
		</div>
	);
}
