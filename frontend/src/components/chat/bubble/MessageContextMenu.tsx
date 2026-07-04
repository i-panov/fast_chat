import { Menu } from "@mantine/core";
import {
	Copy,
	CornerUpLeft,
	MessageCircle,
	Pencil,
	RotateCcw,
	SquareX,
	Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
	opened: boolean;
	position: { x: number; y: number };
	canEdit: boolean;
	canDelete: boolean;
	canCancelSend: boolean;
	canReply: boolean;
	canCreateThread: boolean;
	hasText: boolean;
	status?: "sent" | "queued" | "failed";
	onCopy: () => void;
	onEdit: () => void;
	onRetry: () => void;
	onCancelSend: () => void;
	onReply: () => void;
	onCreateThread: () => void;
	onDelete: () => void;
	onClose: () => void;
	menuRef: React.RefObject<HTMLDivElement | null>;
	firstMenuItemRef: React.RefObject<HTMLButtonElement | null>;
}

export function MessageContextMenu({
	opened,
	position,
	canEdit,
	canDelete,
	canCancelSend,
	canReply,
	canCreateThread,
	hasText,
	status,
	onCopy,
	onEdit,
	onRetry,
	onCancelSend,
	onReply,
	onCreateThread,
	onDelete,
	onClose,
	menuRef,
	firstMenuItemRef,
}: Props) {
	const { t } = useTranslation();

	return (
		<Menu
			opened={opened}
			onClose={onClose}
			withinPortal
			closeOnItemClick={false}
		>
			<Menu.Target>
				<div
					ref={menuRef as React.Ref<HTMLDivElement>}
					style={{
						position: "fixed",
						left: position.x,
						top: position.y,
						width: 0,
						height: 0,
					}}
				/>
			</Menu.Target>
			<Menu.Dropdown>
				{hasText && (
					<Menu.Item
						ref={firstMenuItemRef}
						leftSection={<Copy size={14} />}
						onClick={onCopy}
					>
						{t("message.copy")}
					</Menu.Item>
				)}
				{canEdit && (
					<Menu.Item leftSection={<Pencil size={14} />} onClick={onEdit}>
						{t("message.edit")}
					</Menu.Item>
				)}
				{canCancelSend && (
					<Menu.Item leftSection={<SquareX size={14} />} onClick={onCancelSend}>
						{t("message.cancelSend")}
					</Menu.Item>
				)}
				{status === "failed" && (
					<Menu.Item leftSection={<RotateCcw size={14} />} onClick={onRetry}>
						{t("message.retry")}
					</Menu.Item>
				)}
				{canReply && (
					<Menu.Item leftSection={<CornerUpLeft size={14} />} onClick={onReply}>
						{t("message.reply")}
					</Menu.Item>
				)}
				{canCreateThread && (
					<Menu.Item
						leftSection={<MessageCircle size={14} />}
						onClick={onCreateThread}
					>
						{t("message.createThread")}
					</Menu.Item>
				)}
				{canDelete && (
					<Menu.Item leftSection={<Trash2 size={14} />} onClick={onDelete}>
						{t("message.delete")}
					</Menu.Item>
				)}
			</Menu.Dropdown>
		</Menu>
	);
}
