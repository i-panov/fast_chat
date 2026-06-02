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
import type { FileInfo, PendingFile } from "../../api.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
	editing: boolean;
	onCancelEdit: () => void;
	replyToNick?: string;
	replyToText?: string;
	replyToFiles?: FileInfo[];
	onCancelReply?: () => void;
	onTypingStart?: () => void;
	onTypingStop?: () => void;
	pendingFiles?: PendingFile[];
	onAttachFiles?: (files: FileList) => void;
	onRemoveFile?: (fileId: string) => void;
	existingFiles?: FileInfo[];
	onRemoveExistingFile?: (fileId: string) => void;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReplyFilePreviewInline({
	files,
	token,
}: {
	files: FileInfo[];
	token: string | undefined;
}) {
	if (files.length === 0) return null;
	const first = files[0];
	const extra = files.length - 1;
	const url = token
		? `${first.url}?token=${encodeURIComponent(token)}`
		: first.url;

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				marginTop: 2,
			}}
		>
			{first.fileType === "photo" ? (
				<img
					src={url}
					alt=""
					style={{
						width: 20,
						height: 20,
						objectFit: "cover",
						borderRadius: 3,
						flexShrink: 0,
					}}
				/>
			) : (
				<FileIcon
					size={18}
					style={{ flexShrink: 0, color: "var(--mantine-color-gray-5)" }}
				/>
			)}
			<Text
				size="xs"
				c="dimmed"
				truncate="end"
				style={{ flex: 1, minWidth: 0 }}
			>
				{first.originalName}
			</Text>
			{extra > 0 && (
				<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
					+{extra}
				</Text>
			)}
		</div>
	);
}

function PendingFilePreview({
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

function ExistingFilePreview({
	file,
	onRemove,
	token,
}: {
	file: FileInfo;
	onRemove: () => void;
	token: string | undefined;
}) {
	const url = token
		? `${file.url}?token=${encodeURIComponent(token)}`
		: file.url;

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
				opacity: 0.85,
			}}
		>
			{file.fileType === "photo" ? (
				<img
					src={url}
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
	replyToFiles,
	onCancelReply,
	onTypingStart,
	onTypingStop,
	pendingFiles,
	onAttachFiles,
	onRemoveFile,
	existingFiles,
	onRemoveExistingFile,
}: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const token = activeAccount?.token;
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

	const hasExisting = existingFiles !== undefined && existingFiles.length > 0;
	const hasPending = pendingFiles !== undefined && pendingFiles.length > 0;
	const hasAttachments = hasExisting || hasPending;

	return (
		<div>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				style={{ display: "none" }}
				onChange={handleFileChange}
			/>
			{replyToNick !== undefined && !editing && (
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
							gap: 8,
						}}
					>
						<div style={{ flex: 1, overflow: "hidden", minWidth: 0 }}>
							<Text size="xs" c="blue" truncate="end">
								{t("input.replyingTo", { nick: replyToNick })}
							</Text>
							{(replyToText ?? "").length > 0 ? (
								<Text size="xs" c="dimmed" truncate="end">
									{replyToText}
								</Text>
							) : (
								(replyToFiles ?? []).length > 0 && (
									<ReplyFilePreviewInline
										files={replyToFiles ?? []}
										token={token}
									/>
								)
							)}
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
			{hasAttachments && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
					}}
				>
					<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
						{(existingFiles ?? []).map((file) => (
							<ExistingFilePreview
								key={file.id}
								file={file}
								token={token}
								onRemove={() => onRemoveExistingFile?.(file.id)}
							/>
						))}
						{(pendingFiles ?? []).map((file) => (
							<PendingFilePreview
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
						editing || hasAttachments
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
						text.trim().length === 0 &&
						(pendingFiles ?? []).length === 0 &&
						(existingFiles ?? []).length === 0
					}
					size="sm"
				>
					{editing ? t("input.save") : t("input.send")}
				</Button>
			</form>
		</div>
	);
}
