import { ActionIcon, Group, Paper, Stack, Text } from "@mantine/core";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo, Message, PendingFile, Thread } from "../../api.ts";
import { InputBar } from "./InputBar.tsx";
import { MessageList } from "./MessageList.tsx";

interface Props {
	thread: Thread;
	messages: Message[];
	userId: string;
	onBack: () => void;
	inputText: string;
	setInputText: (v: string) => void;
	onSend: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
	onDelete: (chatId: string, messageId: string) => void;
	onStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	onCancelEdit: () => void;
	onReply?: (chatId: string, messageId: string) => void;
	editTTL: number;
	deleteTTL: number;
	editingMessage: {
		chatId: string;
		messageId: string;
		text: string;
		files?: FileInfo[];
		threadId?: string;
	} | null;
	hasMore: boolean;
	isLoadingMore: boolean;
	onLoadMore: () => void;
	onRetry?: (threadId: string, messageId: string) => void;
	replyToNick?: string;
	replyToText?: string;
	replyToFiles?: FileInfo[];
	onCancelReply?: () => void;
	pendingFiles?: PendingFile[];
	onAttachFiles?: (files: File[]) => void;
	onRemoveFile?: (fileId: string) => void;
	existingFiles?: FileInfo[];
	onRemoveExistingFile?: (fileId: string) => void;
}

export function ThreadView({
	thread,
	messages,
	userId,
	onBack,
	inputText,
	setInputText,
	onSend,
	onDelete,
	onStartEdit,
	onCancelEdit,
	onReply,
	editTTL,
	deleteTTL,
	editingMessage,
	hasMore,
	isLoadingMore,
	onLoadMore,
	onRetry,
	replyToNick,
	replyToText,
	replyToFiles,
	onCancelReply,
	pendingFiles,
	onAttachFiles,
	onRemoveFile,
	existingFiles,
	onRemoveExistingFile,
}: Props) {
	const { t } = useTranslation();

	const handleRetry = useCallback(
		(_chatId: string, messageId: string) => {
			onRetry?.(thread.id, messageId);
		},
		[onRetry, thread.id],
	);

	return (
		<Stack h="100%" gap={0}>
			<Paper
				component="header"
				style={{
					padding: "12px 16px",
					borderRadius: 0,
					background: "var(--mantine-color-dark-8)",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
				}}
			>
				<Group gap={8}>
					<ActionIcon variant="subtle" color="gray" onClick={onBack}>
						<ArrowLeft size={18} />
					</ActionIcon>
					<Text fw={600}>{t("message.thread")}</Text>
				</Group>
			</Paper>
			<Paper
				style={{
					padding: "8px 16px",
					borderRadius: 0,
					background: "var(--mantine-color-dark-7)",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
				}}
			>
				<Text size="xs" c="dimmed">
					{thread.parentMessageFrom}
				</Text>
				<Text
					size="sm"
					style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
				>
					{thread.parentMessageText}
				</Text>
			</Paper>
			<MessageList
				messages={messages}
				userId={userId}
				onDelete={onDelete}
				onStartEdit={onStartEdit}
				onReply={onReply}
				editTTL={editTTL}
				deleteTTL={deleteTTL}
				hasMore={hasMore}
				isLoadingMore={isLoadingMore}
				onLoadMore={onLoadMore}
				isInThread
				onRetry={handleRetry}
			/>
			<InputBar
				text={inputText}
				onTextChange={setInputText}
				onSubmit={onSend}
				editing={editingMessage !== null}
				onCancelEdit={onCancelEdit}
				replyToNick={replyToNick}
				replyToText={replyToText}
				replyToFiles={replyToFiles}
				onCancelReply={onCancelReply}
				pendingFiles={pendingFiles}
				onAttachFiles={onAttachFiles}
				onRemoveFile={onRemoveFile}
				existingFiles={existingFiles}
				onRemoveExistingFile={onRemoveExistingFile}
			/>
		</Stack>
	);
}
