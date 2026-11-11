import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../../types/api.ts";
import type { MessageBubbleProps } from "../MessageBubble.tsx";
import { MessageContextMenu } from "./MessageContextMenu.tsx";

interface MenuProps {
	menuPos: { x: number; y: number } | null;
	canEdit: boolean;
	canDelete: boolean;
	canCancelSend: boolean;
	canReply: boolean;
	canCreateThread: boolean;
	canPin: boolean;
	isPinned: boolean;
	canBlock: boolean;
	canForward: boolean;
	status?: "sent" | "queued" | "failed";
	text: string;
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
	onClose: () => void;
	menuRef: React.RefObject<HTMLDivElement | null>;
	firstMenuItemRef: React.RefObject<HTMLButtonElement | null>;
}

export function BubbleContextMenu({
	menuPos,
	canEdit,
	canDelete,
	canCancelSend,
	canReply,
	canCreateThread,
	canPin,
	isPinned,
	canBlock,
	canForward,
	status,
	text,
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
	onClose,
	menuRef,
	firstMenuItemRef,
}: MenuProps) {
	return (
		<MessageContextMenu
			opened={menuPos !== null}
			position={menuPos ?? { x: 0, y: 0 }}
			canEdit={canEdit}
			canDelete={canDelete}
			canCancelSend={canCancelSend}
			canReply={canReply}
			canCreateThread={canCreateThread}
			canPin={canPin}
			isPinned={isPinned}
			canBlock={canBlock}
			canForward={canForward}
			hasText={text.length > 0}
			status={status}
			onCopy={() => {
				void navigator.clipboard.writeText(text);
				onClose();
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
				void onDelete(chatId, msgId);
				onClose();
			}}
			onClose={onClose}
			menuRef={menuRef}
			firstMenuItemRef={firstMenuItemRef}
		/>
	);
}

const MENU_BUTTON_OPACITY_IDLE = "0.6";

// MessageMenuButton is the keyboard/touch reachable trigger for the
// message actions menu: the bubble otherwise opens it only on right-click.
export function MessageMenuButton({
	onOpen,
}: {
	onOpen: (x: number, y: number) => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			type="button"
			aria-label={t("message.menuActions")}
			aria-haspopup="menu"
			title={t("message.menuActions")}
			onClick={(e) => {
				const rect = e.currentTarget.getBoundingClientRect();
				onOpen(rect.left, rect.bottom);
			}}
			style={{
				position: "absolute",
				right: 2,
				top: 2,
				width: 24,
				height: 24,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				border: "none",
				borderRadius: 6,
				background: "transparent",
				color: "inherit",
				cursor: "pointer",
				opacity: Number(MENU_BUTTON_OPACITY_IDLE),
			}}
			onFocus={(e) => {
				e.currentTarget.style.opacity = "1";
			}}
			onBlur={(e) => {
				e.currentTarget.style.opacity = MENU_BUTTON_OPACITY_IDLE;
			}}
		>
			<span aria-hidden="true" style={{ fontSize: 16, lineHeight: 1 }}>
				⋯
			</span>
		</button>
	);
}
