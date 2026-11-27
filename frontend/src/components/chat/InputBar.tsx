// The composer owns the toolbar, previews, banners and the submit action.
/* eslint-disable max-lines */
import {
	ActionIcon,
	Menu,
	Paper,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	Check,
	FileText,
	Image,
	MapPin,
	Music,
	Paperclip,
	Send,
	Video,
	X,
} from "lucide-react";
import type React from "react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { FileInfo, Location, PendingFile } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { ExistingFilePreview } from "./input/ExistingFilePreview.tsx";
import { LocationPreview } from "./input/LocationPreview.tsx";
import { PendingFilePreview } from "./input/PendingFilePreview.tsx";
import { ReplyFilePreviewInline } from "./input/ReplyFilePreviewInline.tsx";
import { VoiceRecorderButton } from "./input/VoiceRecorderButton.tsx";

const ATTACH_FILE_KEY = "input.attachFile";
const MENU_FILE_KEY = "input.menuFile";
const MENU_LOCATION_KEY = "input.menuLocation";

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
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onCancel}
					aria-label={t("input.cancelReply")}
				>
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
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				onClick={onCancel}
				aria-label={t("input.cancelEdit")}
			>
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

	function pickFiles(accept?: string) {
		const input = fileInputRef.current;
		if (input === null) return;
		// The accept attribute is set per menu item: a photo picker should
		// not offer PDFs, and the attachment preview depends on the MIME
		// type the browser reports.
		input.accept = accept ?? "";
		input.click();
	}

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
			<Menu position="top-start" withArrow shadow="md">
				<Menu.Target>
					<Tooltip label={t(ATTACH_FILE_KEY)}>
						<ActionIcon
							variant="subtle"
							color="gray"
							size="lg"
							style={{ marginBottom: 2 }}
							aria-label={t(ATTACH_FILE_KEY)}
						>
							<Paperclip size={20} />
						</ActionIcon>
					</Tooltip>
				</Menu.Target>
				<Menu.Dropdown>
					<Menu.Item
						leftSection={<FileText size={16} />}
						onClick={() => pickFiles()}
					>
						{t(MENU_FILE_KEY)}
					</Menu.Item>
					<Menu.Item
						leftSection={<Image size={16} />}
						onClick={() => pickFiles("image/*")}
					>
						{t("input.attachPhoto")}
					</Menu.Item>
					<Menu.Item
						leftSection={<Video size={16} />}
						onClick={() => pickFiles("video/*")}
					>
						{t("input.attachVideo")}
					</Menu.Item>
					<Menu.Item
						leftSection={<Music size={16} />}
						onClick={() => pickFiles("audio/*")}
					>
						{t("input.attachAudio")}
					</Menu.Item>
					{onOpenLocationPicker !== undefined && (
						<Menu.Item
							leftSection={<MapPin size={16} />}
							onClick={onOpenLocationPicker}
						>
							{t(MENU_LOCATION_KEY)}
						</Menu.Item>
					)}
				</Menu.Dropdown>
			</Menu>
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
		pendingLocation == null &&
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
	const label = editing ? t("input.save") : t("input.send");
	const disabled = isSendDisabled(
		text,
		pendingFiles,
		existingFiles,
		pendingLocation,
		hasExistingLocation,
	);

	return (
		<Tooltip label={label}>
			<ActionIcon
				type="submit"
				size="lg"
				variant="filled"
				disabled={disabled}
				aria-label={label}
			>
				{editing ? <Check size={18} /> : <Send size={18} />}
			</ActionIcon>
		</Tooltip>
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
	const isMobile = useMediaQuery("(max-width: 48em)") === true;
	const [recording, setRecording] = useState(false);
	const canSend = !isSendDisabled(
		text,
		pendingFiles,
		existingFiles,
		pendingLocation,
		hasExistingLocation,
	);

	return (
		<form
			style={{
				display: "flex",
				alignItems: "flex-end",
				gap: isMobile ? 4 : 8,
				// The gesture bar of a phone overlaps the last row otherwise.
				padding: isMobile
					? "8px 8px calc(8px + env(safe-area-inset-bottom))"
					: 12,
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
			<div style={{ display: recording ? "none" : "flex" }}>
				<AttachToolbar
					onAttachFiles={onAttachFiles}
					onOpenLocationPicker={onOpenLocationPicker}
				/>
			</div>
			<Textarea
				placeholder={t("input.placeholder")}
				value={text}
				onChange={(e) => {
					onTextChange(e.target.value);
					onTypingStart?.();
				}}
				style={{
					flex: 1,
					minWidth: 0,
					display: recording ? "none" : undefined,
				}}
				size="sm"
				styles={isMobile ? { input: { fontSize: 16 } } : undefined}
				autosize
				minRows={1}
				maxRows={6}
				onPaste={(e) => {
					const files = collectClipboardFiles(e.clipboardData?.items);
					if (files.length === 0) return;
					// Attach files but keep the default text paste so
					// clipboard text is not lost when files are present.
					void onAttachFiles?.(files);
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing || e.keyCode === 229) return;
					const coarsePointer =
						typeof window !== "undefined" &&
						window.matchMedia?.("(pointer: coarse)").matches === true;
					if (e.key === "Enter" && !e.shiftKey && !coarsePointer) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
					if (e.key === "Escape" && editing) {
						onCancelEdit();
					}
				}}
			/>
			{!recording && canSend && (
				<SendButton
					editing={editing}
					text={text}
					pendingFiles={pendingFiles}
					existingFiles={existingFiles}
					pendingLocation={pendingLocation}
					hasExistingLocation={hasExistingLocation}
				/>
			)}
			<VoiceRecorderButton
				onAttachFiles={onAttachFiles}
				onRecordingChange={setRecording}
				hidden={canSend}
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
		<div style={{ flex: "0 0 auto" }}>
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
