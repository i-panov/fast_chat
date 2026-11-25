import { Alert, Button, Group, Menu, Modal, Stack, Text } from "@mantine/core";
import {
	Ban,
	Copy,
	CornerUpLeft,
	Forward,
	MessageCircle,
	Pencil,
	Pin,
	PinOff,
	RotateCcw,
	SquareDashedMousePointer,
	SquareX,
	Trash2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
	opened: boolean;
	position: { x: number; y: number };
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
	hasText: boolean;
	hasImage: boolean;
	status?: "sent" | "queued" | "failed";
	onCopy: () => void;
	onEdit: () => void;
	onRetry: () => void | Promise<void>;
	onCancelSend: () => void;
	onReply: () => void;
	onCreateThread: () => void;
	onPin: () => void;
	onBlock: () => void;
	onForward: () => void;
	onDelete: () => void | Promise<void>;
	onSelect: () => void;
	onClose: () => void;
	menuRef: React.RefObject<HTMLDivElement | null>;
	firstMenuItemRef: React.RefObject<HTMLButtonElement | null>;
}

export function MessageContextMenu({
	opened,
	position,
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
	hasText,
	hasImage,
	status,
	onCopy,
	onEdit,
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
}: Props) {
	const { t } = useTranslation();
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [deleteError, setDeleteError] = useState<string | null>(null);

	return (
		<>
			<Menu
				opened={opened}
				onClose={onClose}
				withinPortal
				closeOnItemClick={false}
			>
				<Menu.Target>
					<div
						ref={menuRef}
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
					{(hasText || hasImage) && (
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
						<Menu.Item
							leftSection={<SquareX size={14} />}
							onClick={onCancelSend}
						>
							{t("message.cancelSend")}
						</Menu.Item>
					)}
					{status === "failed" && (
						<Menu.Item
							leftSection={<RotateCcw size={14} />}
							onClick={() => {
								void onRetry();
							}}
						>
							{t("message.retry")}
						</Menu.Item>
					)}
					{canReply && (
						<Menu.Item
							leftSection={<CornerUpLeft size={14} />}
							onClick={onReply}
						>
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
					{canForward && (
						<Menu.Item leftSection={<Forward size={14} />} onClick={onForward}>
							{t("message.forward")}
						</Menu.Item>
					)}
					{canBlock && (
						<Menu.Item leftSection={<Ban size={14} />} onClick={onBlock}>
							{t("message.block")}
						</Menu.Item>
					)}
					{canPin && (
						<Menu.Item
							leftSection={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
							onClick={onPin}
						>
							{isPinned ? t("message.unpin") : t("message.pin")}
						</Menu.Item>
					)}
					{canSelect && (
						<Menu.Item
							leftSection={<SquareDashedMousePointer size={14} />}
							onClick={() => {
								onClose();
								onSelect();
							}}
						>
							{t("message.select")}
						</Menu.Item>
					)}
					{canDelete && (
						<Menu.Item
							leftSection={<Trash2 size={14} />}
							onClick={() => {
								onClose();
								setDeleteError(null);
								setConfirmingDelete(true);
							}}
						>
							{t("message.delete")}
						</Menu.Item>
					)}
				</Menu.Dropdown>
			</Menu>
			<Modal
				opened={confirmingDelete}
				onClose={() => {
					if (!deleting) setConfirmingDelete(false);
				}}
				title={t("message.deleteTitle")}
				centered
				size="sm"
			>
				<Stack gap="md">
					<Text size="sm">{t("message.deleteConfirm")}</Text>
					{deleteError !== null && <Alert color="red">{deleteError}</Alert>}
					<Group justify="flex-end">
						<Button
							variant="default"
							disabled={deleting}
							onClick={() => setConfirmingDelete(false)}
						>
							{t("input.cancel")}
						</Button>
						<Button
							color="red"
							loading={deleting}
							onClick={() => {
								setDeleting(true);
								setDeleteError(null);
								void Promise.resolve(onDelete())
									.then(() => setConfirmingDelete(false))
									.catch((err: unknown) => {
										setDeleteError(
											err instanceof Error ? err.message : String(err),
										);
									})
									.finally(() => setDeleting(false));
							}}
						>
							{t("message.delete")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}
