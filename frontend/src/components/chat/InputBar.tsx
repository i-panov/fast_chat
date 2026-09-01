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

const bannerStyle = {
	padding: "8px 12px",
	borderRadius: 0,
	borderTop: "1px solid var(--mantine-color-dark-4)",
	background: "var(--mantine-color-dark-7)",
};

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
	onAttachFiles?: (files: File[]) => void | Promise<void>;
	onRemoveFile?: (fileId: string) => void;
	existingFiles?: FileInfo[];
	onRemoveExistingFile?: (fileId: string) => void;
	pendingLocation?: Location | null;
	onOpenLocationPicker?: () => void;
	onRemovePendingLocation?: () => void;
	existingLocation?: Location | null;
	onRemoveExistingLocation?: () => void;
}

function collectClipboardFiles(
	items: DataTransferItemList | undefined,
): File[] {
	if (!items) return [];
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
	return files;
}

function ReplyBanner({
	nick,
	text,
	files,
	photoBlobUrl,
	onCancel,
}: {
	nick: string;
	text: string | undefined;
	files: FileInfo[];
	photoBlobUrl: string | null;
	onCancel: (() => void) | undefined;
}) {
	const { t } = useTranslation();
	return (
		<Paper style={bannerStyle}>
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
						{t("input.replyingTo", { nick })}
					</Text>
					{(text ?? "").length > 0 ? (
						<Text size="xs" c="dimmed" truncate="end">
							{text}
						</Text>
					) : (
						files.length > 0 && (
							<ReplyFilePreviewInline
								files={files}
								photoBlobUrl={photoBlobUrl}
							/>
						)
					)}
				</div>
				<ActionIcon variant="subtle" color="gray" size="sm" onClick={onCancel}>
					<X size={16} />
				</ActionIcon>
			</div>
		</Paper>
	);
}

function EditBanner({ onCancel }: { onCancel: () => void }) {
	const { t } = useTranslation();
	return (
		<Paper
			style={{
				...bannerStyle,
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
			}}
		>
			<Text size="sm" c="blue">
				{t("input.editBanner")}
			</Text>
			<ActionIcon variant="subtle" color="gray" size="sm" onClick={onCancel}>
				<X size={16} />
			</ActionIcon>
		</Paper>
	);
}

function AttachmentsBar({
	existingFiles,
	onRemoveExistingFile,
	pendingFiles,
	onRemoveFile,
	existingLocation,
	onRemoveExistingLocation,
	pendingLocation,
	onRemovePendingLocation,
}: {
	existingFiles: FileInfo[] | undefined;
	onRemoveExistingFile?: (fileId: string) => void;
	pendingFiles: PendingFile[] | undefined;
	onRemoveFile?: (fileId: string) => void;
	existingLocation: Location | null | undefined;
	onRemoveExistingLocation?: () => void;
	pendingLocation: Location | null | undefined;
	onRemovePendingLocation?: () => void;
}) {
	const hasExisting = existingFiles !== undefined && existingFiles.length > 0;
	const hasPending = pendingFiles !== undefined && pendingFiles.length > 0;
	const hasExistingLocation =
		existingLocation !== undefined && existingLocation !== null;
	const hasPendingLocation =
		pendingLocation !== undefined && pendingLocation !== null;
	if (!(hasExisting || hasPending || hasExistingLocation || hasPendingLocation))
		return null;
	return (
		<Paper style={bannerStyle}>
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
	);
}

function AttachToolbar({
	onAttachFiles,
	onOpenLocationPicker,
}: {
	onAttachFiles?: (files: File[]) => void | Promise<void>;
	onOpenLocationPicker?: () => void;
}) {
	const { t } = useTranslation();
	const fileInputRef = useRef<HTMLInputElement>(null);

	function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
		if (e.target.files && e.target.files.length > 0 && onAttachFiles) {
			void onAttachFiles(Array.from(e.target.files));
		}
		e.target.value = "";
	}

	return (
		<>
			<input
				ref={fileInputRef}
				type="file"
				multiple
				style={{ display: "none" }}
				onChange={handleFileChange}
			/>
			<div style={{ display: "flex", alignItems: "flex-end" }}>
				<Tooltip label={t("input.attachFile")}>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="lg"
						onClick={() => fileInputRef.current?.click()}
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
		</>
	);
}

function isSendDisabled(
	text: string,
	pendingFiles: PendingFile[] | undefined,
	existingFiles: FileInfo[] | undefined,
	pendingLocation: Location | null | undefined,
	hasExistingLocation: boolean,
) {
	return (
		text.trim().length === 0 &&
		(pendingFiles ?? []).length === 0 &&
		(existingFiles ?? []).length === 0 &&
		pendingLocation === null &&
		!hasExistingLocation
	);
}

function SendButton({
	editing,
	text,
	pendingFiles,
	existingFiles,
	pendingLocation,
	hasExistingLocation,
}: {
	editing: boolean;
	text: string;
	pendingFiles: PendingFile[] | undefined;
	existingFiles: FileInfo[] | undefined;
	pendingLocation: Location | null | undefined;
	hasExistingLocation: boolean;
}) {
	const { t } = useTranslation();
	return (
		<Button
			type="submit"
			disabled={isSendDisabled(
				text,
				pendingFiles,
				existingFiles,
				pendingLocation,
				hasExistingLocation,
			)}
			size="sm"
		>
			{editing ? t("input.save") : t("input.send")}
		</Button>
	);
}

function MessageForm({
	text,
	onTextChange,
	onTypingStart,
	onTypingStop,
	onSubmit,
	editing,
	hasAttachments,
	pendingFiles,
	existingFiles,
	pendingLocation,
	hasExistingLocation,
	onAttachFiles,
	onOpenLocationPicker,
	onCancelEdit,
}: {
	text: string;
	onTextChange: (value: string) => void;
	onTypingStart?: () => void;
	onTypingStop?: () => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
	editing: boolean;
	hasAttachments: boolean;
	pendingFiles: PendingFile[] | undefined;
	existingFiles: FileInfo[] | undefined;
	pendingLocation: Location | null | undefined;
	hasExistingLocation: boolean;
	onAttachFiles?: (files: File[]) => void | Promise<void>;
	onOpenLocationPicker?: () => void;
	onCancelEdit: () => void;
}) {
	const { t } = useTranslation();
	return (
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
			<AttachToolbar
				onAttachFiles={onAttachFiles}
				onOpenLocationPicker={onOpenLocationPicker}
			/>
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
				onPaste={(e) => {
					const files = collectClipboardFiles(e.clipboardData?.items);
					if (files.length === 0) return;
					e.preventDefault();
					void onAttachFiles?.(files);
				}}
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
			<SendButton
				editing={editing}
				text={text}
				pendingFiles={pendingFiles}
				existingFiles={existingFiles}
				pendingLocation={pendingLocation}
				hasExistingLocation={hasExistingLocation}
			/>
		</form>
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
	pendingLocation,
	onOpenLocationPicker,
	onRemovePendingLocation,
	existingLocation,
	onRemoveExistingLocation,
}: Props) {
	const { activeAccount } = useAuth();

	const replyPhotoFile = replyToFiles?.[0];
	const replyPhotoUrl =
		replyPhotoFile?.fileType === "photo" ? replyPhotoFile.url : undefined;
	const { blobUrl: replyPhotoBlobUrl } = useFileUrl(
		replyPhotoUrl,
		activeAccount?.token,
	);

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
			{replyToNick !== undefined && !editing && (
				<ReplyBanner
					nick={replyToNick}
					text={replyToText}
					files={replyToFiles ?? []}
					photoBlobUrl={replyPhotoBlobUrl}
					onCancel={onCancelReply}
				/>
			)}
			{editing && <EditBanner onCancel={onCancelEdit} />}
			<AttachmentsBar
				existingFiles={existingFiles}
				onRemoveExistingFile={onRemoveExistingFile}
				pendingFiles={pendingFiles}
				onRemoveFile={onRemoveFile}
				existingLocation={existingLocation}
				onRemoveExistingLocation={onRemoveExistingLocation}
				pendingLocation={pendingLocation}
				onRemovePendingLocation={onRemovePendingLocation}
			/>
			<MessageForm
				text={text}
				onTextChange={onTextChange}
				onTypingStart={onTypingStart}
				onTypingStop={onTypingStop}
				onSubmit={onSubmit}
				editing={editing}
				hasAttachments={hasAttachments}
				pendingFiles={pendingFiles}
				existingFiles={existingFiles}
				pendingLocation={pendingLocation}
				hasExistingLocation={hasExistingLocation}
				onAttachFiles={onAttachFiles}
				onOpenLocationPicker={onOpenLocationPicker}
				onCancelEdit={onCancelEdit}
			/>
		</div>
	);
}
