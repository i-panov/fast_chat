import {
	ActionIcon,
	Button,
	Paper,
	Stack,
	UnstyledButton,
} from "@mantine/core";
import {
	Copy,
	CornerUpLeft,
	MessageCircle,
	Pencil,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";

const MENU_MIN_WIDTH = 140;

interface Props {
	opened: boolean;
	position: { x: number; y: number };
	canEdit: boolean;
	canDelete: boolean;
	canReply: boolean;
	canCreateThread: boolean;
	hasText: boolean;
	status?: "sent" | "queued" | "failed";
	onCopy: () => void;
	onEdit: () => void;
	onRetry: () => void;
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
	canReply,
	canCreateThread,
	hasText,
	status,
	onCopy,
	onEdit,
	onRetry,
	onReply,
	onCreateThread,
	onDelete,
	onClose,
	menuRef,
	firstMenuItemRef,
}: Props) {
	const { t } = useTranslation();

	if (!opened) return null;

	return (
		<>
			<UnstyledButton
				style={{
					position: "fixed",
					inset: 0,
					zIndex: 999,
					cursor: "default",
				}}
				onClick={onClose}
				aria-label={t("media.closeMenu")}
			/>
			<Paper
				ref={menuRef}
				style={{
					position: "fixed",
					left: position.x,
					top: position.y,
					zIndex: 1000,
					minWidth: MENU_MIN_WIDTH,
				}}
				role="menu"
				aria-label={t("media.messageActions")}
			>
				<Stack gap={0}>
					{hasText && (
						<Button
							ref={firstMenuItemRef}
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onCopy}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
								<Copy size={14} />
							</ActionIcon>
							{t("message.copy")}
						</Button>
					)}
					{canEdit && (
						<Button
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onEdit}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
								<Pencil size={14} />
							</ActionIcon>
							{t("message.edit")}
						</Button>
					)}
					{status === "failed" && (
						<Button
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onRetry}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
								<RotateCcw size={14} />
							</ActionIcon>
							{t("message.retry")}
						</Button>
					)}
					{canReply && (
						<Button
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onReply}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
								<CornerUpLeft size={14} />
							</ActionIcon>
							{t("message.reply")}
						</Button>
					)}
					{canCreateThread && (
						<Button
							variant="subtle"
							color="gray"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onCreateThread}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
								<MessageCircle size={14} />
							</ActionIcon>
							{t("message.createThread")}
						</Button>
					)}
					{canDelete && (
						<Button
							variant="subtle"
							color="red"
							fullWidth
							justify="flex-start"
							style={{ borderRadius: 0 }}
							onClick={onDelete}
							role="menuitem"
						>
							<ActionIcon variant="transparent" color="red" size={18} mr={6}>
								<Trash2 size={14} />
							</ActionIcon>
							{t("message.delete")}
						</Button>
					)}
				</Stack>
			</Paper>
		</>
	);
}
