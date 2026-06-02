import {
	ActionIcon,
	Button,
	Paper,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { FileIcon, Paperclip, X } from "lucide-react";
import type React from "react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import type { PendingFile } from "../../api.ts";

interface Props {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
	editing: boolean;
	onCancelEdit: () => void;
	replyToNick?: string;
	replyToText?: string;
	onCancelReply?: () => void;
	onTypingStart?: () => void;
	onTypingStop?: () => void;
	pendingFiles?: PendingFile[];
	onAttachFiles?: (files: FileList) => void;
	onRemoveFile?: (fileId: string) => void;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FilePreview({
	file,
	onRemove,
}: {
	file: PendingFile;
	onRemove: () => void;
}) {
	return (
		<Paper
			style={{
				padding: "6px 10px",
				display: "flex",
				alignItems: "center",
				gap: 8,
				background: "var(--mantine-color-dark-6)",
				borderRadius: 6,
				maxWidth: 200,
			}}
		>
			{file.fileType === "photo" ? (
				<img
					src={file.blobUrl}
					alt=""
					style={{ width: 32, height: 32, objectFit: "cover", borderRadius: 4 }}
				/>
			) : (
				<FileIcon size={24} style={{ flexShrink: 0 }} />
			)}
			<div style={{ overflow: "hidden", minWidth: 0 }}>
				<Text size="xs" truncate="end">
					{file.originalName}
				</Text>
				<Text size="xs" c="dimmed">
					{formatSize(file.size)}
				</Text>
			</div>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				onClick={onRemove}
				style={{ flexShrink: 0 }}
			>
				<X size={14} />
			</ActionIcon>
		</Paper>
	);
}

export function InputBar({
	text,
	onTextChange,
	onSubmit,
	editing,
	onCancelEdit,
	replyToNick,
	replyToText,
	onCancelReply,
	onTypingStart,
	onTypingStop,
	pendingFiles,
	onAttachFiles,
	onRemoveFile,
}: Props) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);

	function handleAttachClick() {
		fileInputRef.current?.click();
	}

	function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
		if (e.target.files && e.target.files.length > 0 && onAttachFiles) {
			onAttachFiles(e.target.files);
		}
		e.target.value = "";
	}

	return (
		<div>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				style={{ display: "none" }}
				onChange={handleFileChange}
			/>
			{replyToNick !== undefined && replyToText !== undefined && !editing && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
					}}
				>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
						}}
					>
						<div style={{ flex: 1, overflow: "hidden" }}>
							<Text size="xs" c="blue" truncate="end">
								{t("input.replyingTo", { nick: replyToNick })}
							</Text>
							<Text size="xs" c="dimmed" truncate="end">
								{replyToText}
							</Text>
						</div>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="sm"
							onClick={onCancelReply}
						>
							<X size={16} />
						</ActionIcon>
					</div>
				</Paper>
			)}
			{editing && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<Text size="sm" c="blue">
						{t("input.editBanner")}
					</Text>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						onClick={onCancelEdit}
					>
						<X size={16} />
					</ActionIcon>
				</Paper>
			)}
			{pendingFiles !== undefined && pendingFiles.length > 0 && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
					}}
				>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						{pendingFiles.map((file) => (
							<FilePreview
								key={file.id}
								file={file}
								onRemove={() => onRemoveFile?.(file.id)}
							/>
						))}
					</div>
				</Paper>
			)}
			<form
				style={{
					display: "flex",
					gap: "8px",
					padding: "12px",
					borderTop:
						editing || (pendingFiles !== undefined && pendingFiles.length > 0)
							? undefined
							: "1px solid var(--mantine-color-dark-4)",
					background: "var(--mantine-color-dark-8)",
				}}
				onSubmit={(e) => {
					onTypingStop?.();
					onSubmit(e);
				}}
			>
				<div style={{ display: "flex", alignItems: "flex-end" }}>
					<Tooltip label={t("input.attachFile")}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="lg"
							onClick={handleAttachClick}
							style={{ marginBottom: 2 }}
						>
							<Paperclip size={20} />
						</ActionIcon>
					</Tooltip>
				</div>
				<Textarea
					placeholder={t("input.placeholder")}
					value={text}
					onChange={(e) => {
						onTextChange(e.target.value);
						onTypingStart?.();
					}}
					style={{ flex: 1 }}
					size="sm"
					autosize
					minRows={1}
					maxRows={6}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							e.currentTarget.form?.requestSubmit();
						}
						if (e.key === "Escape" && editing) {
							onCancelEdit();
						}
					}}
				/>
				<Button
					type="submit"
					disabled={
						text.trim().length === 0 && (pendingFiles ?? []).length === 0
					}
					size="sm"
				>
					{editing ? t("input.save") : t("input.send")}
				</Button>
			</form>
		</div>
	);
}
