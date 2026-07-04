import { ActionIcon, Group, Paper, Stack, Text } from "@mantine/core";
import { ArrowLeft } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useChatContext } from "../../context/ChatContext.tsx";
import { InputBar } from "./InputBar.tsx";
import { MessageList } from "./MessageList.tsx";

export function ThreadView() {
	const { t } = useTranslation();
	const {
		activeThread,
		activeThreadMessages,
		user,
		activeAccount,
		handleCloseThread,
		inputText,
		setInputText,
		handleSendThreadMessage,
		handleStartEdit,
		handleCancelEdit,
		handleReply,
		config,
		editingMessage,
		threadHasMore,
		threadIsLoadingMore,
		loadMoreThreadMessages,
		handleRetryThreadMessage,
		activeThreadId,
		activeChatId,
		handleDeleteThreadMessage,
		handleCancelSendMessage,
		replyToMessage,
		cancelReply,
		pendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		pendingLocation,
		openLocationPicker,
		clearPendingLocation,
		handleRemoveExistingFile,
		handleRemoveExistingLocation,
	} = useChatContext();

	const handleDelete = useCallback(
		(_chatId: string, messageId: string) => {
			if (activeThreadId !== null) {
				handleDeleteThreadMessage(activeThreadId, messageId);
			}
		},
		[activeThreadId, handleDeleteThreadMessage],
	);

	const handleCancel = useCallback(
		(_chatId: string, messageId: string) => {
			if (activeThreadId !== null) {
				handleCancelSendMessage(activeChatId ?? "", messageId, activeThreadId);
			}
		},
		[activeThreadId, activeChatId, handleCancelSendMessage],
	);

	const handleRetry = useCallback(
		async (_chatId: string, messageId: string) => {
			if (activeThread !== null) {
				await handleRetryThreadMessage(activeThread.id, messageId);
			}
		},
		[handleRetryThreadMessage, activeThread],
	);

	if (activeThread === null) return null;

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
					<ActionIcon variant="subtle" color="gray" onClick={handleCloseThread}>
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
					{activeThread.parentMessageFrom}
				</Text>
				<Text
					size="sm"
					style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
				>
					{activeThread.parentMessageText}
				</Text>
			</Paper>
			<MessageList
				messages={activeThreadMessages}
				userId={user?.id ?? ""}
				chatId={activeChatId}
				token={activeAccount?.token}
				onDelete={handleDelete}
				onStartEdit={handleStartEdit}
				onReply={handleReply}
				editTTL={config?.messageEditTTL ?? 0}
				deleteTTL={config?.messageDeleteTTL ?? 0}
				hasMore={threadHasMore}
				isLoadingMore={threadIsLoadingMore}
				onLoadMore={loadMoreThreadMessages}
				isInThread
				onRetry={handleRetry}
				onCancelSend={handleCancel}
			/>
			<InputBar
				text={inputText}
				onTextChange={setInputText}
				onSubmit={handleSendThreadMessage}
				editing={editingMessage !== null}
				onCancelEdit={handleCancelEdit}
				replyToNick={replyToMessage?.fromNick}
				replyToText={replyToMessage?.text}
				replyToFiles={replyToMessage?.files}
				onCancelReply={cancelReply}
				pendingFiles={pendingFiles}
				onAttachFiles={handleAttachFiles}
				onRemoveFile={handleRemoveFile}
				existingFiles={editingMessage?.files}
				onRemoveExistingFile={handleRemoveExistingFile}
				pendingLocation={pendingLocation}
				onOpenLocationPicker={openLocationPicker}
				onRemovePendingLocation={clearPendingLocation}
				existingLocation={editingMessage?.location ?? null}
				onRemoveExistingLocation={handleRemoveExistingLocation}
			/>
		</Stack>
	);
}
