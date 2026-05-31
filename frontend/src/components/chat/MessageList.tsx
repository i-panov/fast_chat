import { Loader, Text } from "@mantine/core";
import { Fragment, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { Message } from "../../api.ts";
import { formatDateLabel, formatTime } from "../../utils/chat.ts";
import { MessageBubble } from "./MessageBubble.tsx";

function DateSeparator({ dateStr }: { dateStr: string }) {
	return (
		<Text ta="center" size="xs" c="dimmed" py={6}>
			{formatDateLabel(dateStr)}
		</Text>
	);
}

interface Props {
	messages: Message[];
	userId: string;
	onDelete: (chatId: string, messageId: string) => void;
	onStartEdit: (chatId: string, messageId: string, text: string) => void;
	editTTL: number;
	deleteTTL: number;
	hasMore?: boolean;
	isLoadingMore?: boolean;
	onLoadMore?: () => void;
}

export function MessageList({
	messages,
	userId,
	onDelete,
	onStartEdit,
	editTTL,
	deleteTTL,
	hasMore,
	isLoadingMore,
	onLoadMore,
}: Props) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);
	const scrollAnchorRef = useRef(0);

	useEffect(() => {
		const el = sentinelRef.current;
		if (!el || !hasMore || !onLoadMore || isLoadingMore) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (entry.isIntersecting) {
					const container = containerRef.current;
					if (container) {
						scrollAnchorRef.current =
							container.scrollHeight - container.scrollTop;
					}
					onLoadMore();
				}
			},
			{ rootMargin: "200px 0px" },
		);

		observer.observe(el);
		return () => observer.disconnect();
	}, [hasMore, onLoadMore, isLoadingMore]);

	useEffect(() => {
		if (!isLoadingMore && scrollAnchorRef.current > 0) {
			const container = containerRef.current;
			if (container) {
				container.scrollTop = container.scrollHeight - scrollAnchorRef.current;
			}
			scrollAnchorRef.current = 0;
		}
	}, [isLoadingMore]);

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

	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	let lastDateKey = "";

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
				{messages.map((msg) => {
					const dateKey = new Date(msg.createdAt).toLocaleDateString(
						"ru-RU",
						fmt,
					);
					const showSeparator = dateKey !== lastDateKey;
					lastDateKey = dateKey;

					return (
						<Fragment key={msg.id}>
							{showSeparator && <DateSeparator dateStr={msg.createdAt} />}
							<MessageBubble
								text={msg.text}
								isOwn={msg.fromId === userId}
								time={formatTime(msg.createdAt)}
								chatId={msg.chatId}
								msgId={msg.id}
								editedAt={msg.editedAt}
								onStartEdit={onStartEdit}
								onDelete={onDelete}
								editTTL={editTTL}
								deleteTTL={deleteTTL}
								createdAt={msg.createdAt}
							/>
						</Fragment>
					);
				})}
			</div>
		</div>
	);
}
