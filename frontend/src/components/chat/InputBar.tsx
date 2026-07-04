import {
	ActionIcon,
	Button,
	Paper,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { MapPin, Paperclip, X } from "lucide-react";
import type React from "react";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { FileInfo, Location, PendingFile } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { ExistingFilePreview } from "./input/ExistingFilePreview.tsx";
import { LocationPreview } from "./input/LocationPreview.tsx";
import { PendingFilePreview } from "./input/PendingFilePreview.tsx";
import { ReplyFilePreviewInline } from "./input/ReplyFilePreviewInline.tsx";

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
	onAttachFiles?: (files: File[]) => void;
	onRemoveFile?: (fileId: string) => void;
	existingFiles?: FileInfo[];
	onRemoveExistingFile?: (fileId: string) => void;
	pendingLocation?: Location | null;
	onOpenLocationPicker?: () => void;
	onRemovePendingLocation?: () => void;
	existingLocation?: Location | null;
	onRemoveExistingLocation?: () => void;
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
	pendingLocation,
	onOpenLocationPicker,
	onRemovePendingLocation,
	existingLocation,
	onRemoveExistingLocation,
}: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const fileInputRef = useRef<HTMLInputElement>(null);

	const replyPhotoFile = replyToFiles?.[0];
	const replyPhotoUrl =
		replyPhotoFile?.fileType === "photo" ? replyPhotoFile.url : undefined;
	const { blobUrl: replyPhotoBlobUrl } = useFileUrl(
		replyPhotoUrl,
		activeAccount?.token,
	);

	function handleAttachClick() {
		fileInputRef.current?.click();
	}

	function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
		if (e.target.files && e.target.files.length > 0 && onAttachFiles) {
			onAttachFiles(Array.from(e.target.files));
		}
		e.target.value = "";
	}

	function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
		const items = e.clipboardData?.items;
		if (!items) return;
		const files: File[] = [];
		let idx = 0;
		for (const item of Array.from(items)) {
			if (item.kind !== "file") continue;
			const f = item.getAsFile();
			if (!f) continue;
			const ext = f.type.split("/")[1]?.replace("jpeg", "jpg") || "";
			const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
			const base =
				idx === 0 ? `clipboard-${stamp}` : `clipboard-${stamp}-${idx + 1}`;
			const name = ext ? `${base}.${ext}` : base;
			files.push(new File([f], name, { type: f.type }));
			idx++;
		}
		if (files.length === 0) return; // текст/не-файл — дефолт
		e.preventDefault();
		onAttachFiles?.(files);
	}

	const hasExisting = existingFiles !== undefined && existingFiles.length > 0;
	const hasPending = pendingFiles !== undefined && pendingFiles.length > 0;
	const hasExistingLocation =
		existingLocation !== undefined && existingLocation !== null;
	const hasPendingLocation =
		pendingLocation !== undefined && pendingLocation !== null;
	const hasAttachments =
		hasExisting || hasPending || hasExistingLocation || hasPendingLocation;

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
										photoBlobUrl={replyPhotoBlobUrl}
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
						{hasExistingLocation && existingLocation !== null && (
							<LocationPreview
								location={existingLocation}
								dimmed
								onRemove={() => onRemoveExistingLocation?.()}
							/>
						)}
						{hasPendingLocation && pendingLocation !== null && (
							<LocationPreview
								location={pendingLocation}
								dimmed={false}
								onRemove={() => onRemovePendingLocation?.()}
							/>
						)}
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
							aria-label={t("input.attachFile")}
						>
							<Paperclip size={20} />
						</ActionIcon>
					</Tooltip>
					{onOpenLocationPicker !== undefined && (
						<Tooltip label={t("input.attachLocation")}>
							<ActionIcon
								variant="subtle"
								color="gray"
								size="lg"
								onClick={onOpenLocationPicker}
								style={{ marginBottom: 2 }}
								aria-label={t("input.attachLocation")}
							>
								<MapPin size={20} />
							</ActionIcon>
						</Tooltip>
					)}
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
					onPaste={handlePaste}
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
						(existingFiles ?? []).length === 0 &&
						pendingLocation === null &&
						!hasExistingLocation
					}
					size="sm"
				>
					{editing ? t("input.save") : t("input.send")}
				</Button>
			</form>
		</div>
	);
}
