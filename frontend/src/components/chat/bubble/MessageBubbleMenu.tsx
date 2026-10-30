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
	status?: "sent" | "queued" | "failed";
	text: string;
	chatId: string;
	msgId: string;
	files?: FileInfo[];
	threadId?: string;
	onStartEdit: MessageBubbleProps["onStartEdit"];
	onRetry: MessageBubbleProps["onRetry"];
	onCancelSend: MessageBubbleProps["onCancelSend"];
	onReply: MessageBubbleProps["onReply"];
	onCreateThread: MessageBubbleProps["onCreateThread"];
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
	status,
	text,
	chatId,
	msgId,
	files,
	threadId,
	onStartEdit,
	onRetry,
	onCancelSend,
	onReply,
	onCreateThread,
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
