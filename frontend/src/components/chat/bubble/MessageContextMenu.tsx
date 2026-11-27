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

function DeleteMessageDialog({
	opened,
	deleting,
	error,
	onCancel,
	onDelete,
}: {
	opened: boolean;
	deleting: boolean;
	error: string | null;
	onCancel: () => void;
	onDelete: () => Promise<void> | void;
}) {
	const { t } = useTranslation();
	return (
		<Modal
			opened={opened}
			onClose={onCancel}
			title={t("message.deleteTitle")}
			centered
			size="sm"
		>
			<Stack gap="md">
				<Text size="sm">{t("message.deleteConfirm")}</Text>
				{error !== null && <Alert color="red">{error}</Alert>}
				<Group justify="flex-end">
					<Button variant="default" disabled={deleting} onClick={onCancel}>
						{t("input.cancel")}
					</Button>
					<Button
						color="red"
						loading={deleting}
						onClick={() => {
							void Promise.resolve(onDelete()).finally(() => {});
						}}
					>
						{t("message.delete")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

// The menu keeps the item order and the focus wiring in one place; the
// extracted dialog already carries the delete flow.
// eslint-disable-next-line max-lines-per-function -- one menu with its item conditions
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

	// The focus target must be the first item that is actually rendered: a
	// message without text or an image used to render no "Copy" item and the
	// menu opened without focus, so arrow keys did nothing until Tab.
	const firstShownIndex = [
		hasText || hasImage,
		canEdit,
		canCancelSend,
		status === "failed",
		canReply,
		canCreateThread,
		canForward,
		canBlock,
		canPin,
		canSelect,
		canDelete,
	].indexOf(true);
	const firstRef = (index: number) =>
		index === firstShownIndex ? firstMenuItemRef : undefined;

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
							ref={firstRef(0)}
							leftSection={<Copy size={14} />}
							onClick={onCopy}
						>
							{t("message.copy")}
						</Menu.Item>
					)}
					{canEdit && (
						<Menu.Item
							ref={firstRef(1)}
							leftSection={<Pencil size={14} />}
							onClick={onEdit}
						>
							{t("message.edit")}
						</Menu.Item>
					)}
					{canCancelSend && (
						<Menu.Item
							ref={firstRef(2)}
							leftSection={<SquareX size={14} />}
							onClick={onCancelSend}
						>
							{t("message.cancelSend")}
						</Menu.Item>
					)}
					{status === "failed" && (
						<Menu.Item
							ref={firstRef(3)}
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
							ref={firstRef(4)}
							leftSection={<CornerUpLeft size={14} />}
							onClick={onReply}
						>
							{t("message.reply")}
						</Menu.Item>
					)}
					{canCreateThread && (
						<Menu.Item
							ref={firstRef(5)}
							leftSection={<MessageCircle size={14} />}
							onClick={onCreateThread}
						>
							{t("message.createThread")}
						</Menu.Item>
					)}
					{canForward && (
						<Menu.Item
							ref={firstRef(6)}
							leftSection={<Forward size={14} />}
							onClick={onForward}
						>
							{t("message.forward")}
						</Menu.Item>
					)}
					{canBlock && (
						<Menu.Item
							ref={firstRef(7)}
							leftSection={<Ban size={14} />}
							onClick={onBlock}
						>
							{t("message.block")}
						</Menu.Item>
					)}
					{canPin && (
						<Menu.Item
							ref={firstRef(8)}
							leftSection={isPinned ? <PinOff size={14} /> : <Pin size={14} />}
							onClick={onPin}
						>
							{isPinned ? t("message.unpin") : t("message.pin")}
						</Menu.Item>
					)}
					{canSelect && (
						<Menu.Item
							ref={firstRef(9)}
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
							ref={firstRef(10)}
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
			<DeleteMessageDialog
				opened={confirmingDelete}
				deleting={deleting}
				error={deleteError}
				onCancel={() => {
					if (!deleting) setConfirmingDelete(false);
				}}
				onDelete={async () => {
					setDeleting(true);
					setDeleteError(null);
					try {
						await Promise.resolve(onDelete());
						setConfirmingDelete(false);
					} catch (err) {
						setDeleteError(err instanceof Error ? err.message : String(err));
					} finally {
						setDeleting(false);
					}
				}}
			/>
		</>
	);
}
