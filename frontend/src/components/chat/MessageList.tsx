import { Text } from "@mantine/core";
import { Fragment } from "react";
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
}

export function MessageList({ messages, userId, onDelete }: Props) {
	if (messages.length === 0) {
		return (
			<Text ta="center" c="dimmed" size="sm" py={32}>
				No messages yet
			</Text>
		);
	}

	const fmt: Intl.DateTimeFormatOptions = {
		day: "2-digit",
		month: "2-digit",
		year: "numeric",
	};
	let lastDateKey = "";

	return (
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
							onDelete={onDelete}
						/>
					</Fragment>
				);
			})}
		</div>
	);
}
