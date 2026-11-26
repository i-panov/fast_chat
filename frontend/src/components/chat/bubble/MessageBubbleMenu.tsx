import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../../types/api.ts";
import { emitNotification } from "../../../utils/notify.ts";
import type { MessageBubbleProps } from "../MessageBubble.tsx";
import { MessageContextMenu } from "./MessageContextMenu.tsx";

interface MenuProps {
	menuPos: { x: number; y: number } | null;
	canEdit: boolean;
	canDelete: boolean;
	canSelect: boolean;
	canCancelSend: boolean;
	canReply: boolean;
	canCreateThread: boolean;
	canPin: boolean;
	isPinned: boolean;
	canBlock: boolean;
	canForward: boolean;
	status?: "sent" | "queued" | "failed";
	text: string;
	hasImage: boolean;
	onCopyImage: () => Promise<void>;
	chatId: string;
	msgId: string;
	fromId: string;
	files?: FileInfo[];
	threadId?: string;
	onStartEdit: MessageBubbleProps["onStartEdit"];
	onRetry: MessageBubbleProps["onRetry"];
	onCancelSend: MessageBubbleProps["onCancelSend"];
	onReply: MessageBubbleProps["onReply"];
	onCreateThread: MessageBubbleProps["onCreateThread"];
	onPin: MessageBubbleProps["onPin"];
	onBlock: MessageBubbleProps["onBlock"];
	onForward: MessageBubbleProps["onForward"];
	onDelete: MessageBubbleProps["onDelete"];
	onSelect: () => void;
	onClose: () => void;
	menuRef: React.RefObject<HTMLDivElement | null>;
	firstMenuItemRef: React.RefObject<HTMLButtonElement | null>;
}

export function BubbleContextMenu({
	menuPos,
	canEdit,
	canDelete,
	canSelect,
	canCancelSend,
	canReply,
	canCreateThread,
	canPin,
	isPinned,
	canBlock,
	canForward,
	status,
	text,
	hasImage,
	onCopyImage,
	chatId,
	msgId,
	fromId,
	files,
	threadId,
	onStartEdit,
	onRetry,
	onCancelSend,
	onReply,
	onCreateThread,
	onPin,
	onBlock,
	onForward,
	onDelete,
	onSelect,
	onClose,
	menuRef,
	firstMenuItemRef,
}: MenuProps) {
	const { t } = useTranslation();

	return (
		<MessageContextMenu
			opened={menuPos !== null}
			position={menuPos ?? { x: 0, y: 0 }}
			canEdit={canEdit}
			canDelete={canDelete}
			canSelect={canSelect}
			canCancelSend={canCancelSend}
			canReply={canReply}
			canCreateThread={canCreateThread}
			canPin={canPin}
			isPinned={isPinned}
			canBlock={canBlock}
			canForward={canForward}
			hasText={text.length > 0}
			hasImage={hasImage}
			status={status}
			onCopy={() => {
				// A photo with a caption still copies the photo: that is what
				// the menu item is for on an image message.
				if (!hasImage) {
					if (navigator.clipboard === undefined) {
						emitNotification(t("message.copyTextFailed"));
					} else {
						void navigator.clipboard
							.writeText(text)
							.catch(() => emitNotification(t("message.copyTextFailed")));
					}
					onClose();
					return;
				}
				void onCopyImage()
					.catch(() => {
						emitNotification(t("message.copyImageFailed"));
					})
					.finally(onClose);
			}}
			onEdit={() => {
				onStartEdit(chatId, msgId, text, files, threadId);
				onClose();
			}}
			onRetry={() => {
				void onRetry?.(chatId, msgId);
				onClose();
			}}
			onCancelSend={() => {
				onCancelSend?.(chatId, msgId);
				onClose();
			}}
			onReply={() => {
				onReply?.(chatId, msgId);
				onClose();
			}}
			onCreateThread={() => {
				onCreateThread?.(chatId, msgId);
				onClose();
			}}
			onPin={() => {
				onPin?.(chatId, msgId);
				onClose();
			}}
			onBlock={() => {
				onBlock?.(fromId);
				onClose();
			}}
			onForward={() => {
				onForward?.(chatId, msgId);
				onClose();
			}}
			onDelete={() => {
				onClose();

				return onDelete(chatId, msgId);
			}}
			onSelect={onSelect}
			onClose={onClose}
			menuRef={menuRef}
			firstMenuItemRef={firstMenuItemRef}
		/>
	);
}
