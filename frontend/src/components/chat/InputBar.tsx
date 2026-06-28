import {
	ActionIcon,
	Button,
	Loader,
	Paper,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { FileIcon, MapPin, Paperclip, X } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FileInfo, Location, PendingFile } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";
import { formatCoords } from "../../utils/chat.ts";

// Константы для стилей
const PENDING_FILE_MAX_WIDTH = 200;
const LOCATION_PREVIEW_MAX_WIDTH = 240;
const PREVIEW_SIZE = 32;
const PREVIEW_BORDER_RADIUS = 4;

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

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useVideoThumbnail(blobUrl: string | undefined): string | null {
	const [thumb, setThumb] = useState<string | null>(null);
	useEffect(() => {
		if (!blobUrl) {
			setThumb(null);
			return;
		}
		const video = document.createElement("video");
		video.preload = "metadata";
		video.muted = true;
		video.playsInline = true;
		video.src = blobUrl;
		let cancelled = false;

		const onSeeked = () => {
			if (cancelled) return;
			const w = video.videoWidth || 320;
			const h = video.videoHeight || 240;
			const canvas = document.createElement("canvas");
			canvas.width = w;
			canvas.height = h;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			try {
				ctx.drawImage(video, 0, 0, w, h);
				setThumb(canvas.toDataURL("image/jpeg", 0.7));
			} catch {
				/* canvas tainted — fallback to icon */
			}
		};

		const onLoaded = () => {
			const seekTo =
				video.duration > 0 ? Math.min(0.1, video.duration / 2) : 0.1;
			video.currentTime = seekTo;
		};

		video.addEventListener("loadedmetadata", onLoaded);
		video.addEventListener("seeked", onSeeked);

		return () => {
			cancelled = true;
			video.removeEventListener("loadedmetadata", onLoaded);
			video.removeEventListener("seeked", onSeeked);
			video.removeAttribute("src");
			video.load();
			setThumb(null);
		};
	}, [blobUrl]);
	return thumb;
}

function ReplyFilePreviewInline({
	files,
	photoBlobUrl,
}: {
	files: FileInfo[];
	photoBlobUrl: string | null;
}) {
	if (files.length === 0) return null;
	const first = files[0];
	const extra = files.length - 1;

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				marginTop: 2,
			}}
		>
			{first.fileType === "photo" && photoBlobUrl ? (
				<img
					src={photoBlobUrl}
					alt=""
					style={{
						width: 20,
						height: 20,
						objectFit: "cover",
						borderRadius: 3,
						flexShrink: 0,
					}}
				/>
			) : first.fileType === "photo" ? (
				<Loader size="xs" />
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
	const videoThumb = useVideoThumbnail(
		file.fileType === "video" ? file.blobUrl : undefined,
	);

	return (
		<Paper
			style={{
				padding: "6px 10px",
				display: "flex",
				alignItems: "center",
				gap: 8,
				background: "var(--mantine-color-dark-6)",
				borderRadius: 6,
				maxWidth: PENDING_FILE_MAX_WIDTH,
			}}
		>
			{file.fileType === "photo" ? (
				<img
					src={file.blobUrl}
					alt=""
					style={{
						width: PREVIEW_SIZE,
						height: PREVIEW_SIZE,
						objectFit: "cover",
						borderRadius: PREVIEW_BORDER_RADIUS,
					}}
				/>
			) : file.fileType === "video" ? (
				videoThumb ? (
					<img
						src={videoThumb}
						alt=""
						style={{
							width: PREVIEW_SIZE,
							height: PREVIEW_SIZE,
							objectFit: "cover",
							borderRadius: PREVIEW_BORDER_RADIUS,
						}}
					/>
				) : (
					<div
						style={{
							width: PREVIEW_SIZE,
							height: PREVIEW_SIZE,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							background: "var(--mantine-color-dark-5)",
							borderRadius: PREVIEW_BORDER_RADIUS,
							flexShrink: 0,
						}}
					>
						<Loader size="xs" color="gray" />
					</div>
				)
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
}: {
	file: FileInfo;
	onRemove: () => void;
}) {
	const { activeAccount } = useAuth();
	const { blobUrl, loading } = useFileUrl(
		file.fileType === "photo" ? file.url : undefined,
		activeAccount?.token,
	);

	return (
		<Paper
			style={{
				padding: "6px 10px",
				display: "flex",
				alignItems: "center",
				gap: 8,
				background: "var(--mantine-color-dark-6)",
				borderRadius: 6,
				maxWidth: PENDING_FILE_MAX_WIDTH,
				opacity: 0.85,
			}}
		>
			{file.fileType === "photo" && blobUrl ? (
				<img
					src={blobUrl}
					alt=""
					style={{
						width: PREVIEW_SIZE,
						height: PREVIEW_SIZE,
						objectFit: "cover",
						borderRadius: PREVIEW_BORDER_RADIUS,
					}}
				/>
			) : file.fileType === "photo" && loading ? (
				<Loader size="xs" />
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

function LocationPreview({
	location,
	onRemove,
	dimmed,
}: {
	location: Location;
	onRemove: () => void;
	dimmed: boolean;
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
				maxWidth: LOCATION_PREVIEW_MAX_WIDTH,
				opacity: dimmed ? 0.85 : 1,
			}}
		>
			<MapPin
				size={20}
				style={{ flexShrink: 0, color: "var(--mantine-color-blue-5)" }}
			/>
			<div style={{ overflow: "hidden", minWidth: 0 }}>
				<Text size="xs" truncate="end">
					{formatCoords(location)}
				</Text>
			</div>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				onClick={onRemove}
				style={{ flexShrink: 0 }}
				aria-label="Remove location"
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
