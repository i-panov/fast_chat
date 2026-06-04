import {
	ActionIcon,
	Anchor,
	Button,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import {
	Check,
	Copy,
	CornerUpLeft,
	FileAudio,
	FileIcon,
	MapPin,
	MessageCircle,
	Pencil,
	RotateCcw,
	Trash2,
} from "lucide-react";
import { isValidElement, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FileInfo, Location, ReplyToInfo } from "../../api.ts";
import { useAudioPlayer } from "../../useAudioPlayer.tsx";
import { useAuth } from "../../useAuth.tsx";
import { extractCodeText, formatCoords } from "../../utils/chat.ts";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { LocationLightbox } from "./LocationLightbox.tsx";
import { LocationMiniMap } from "./LocationMiniMap.tsx";

interface CodeBlockProps {
	className?: string;
	code: string;
	lang: string;
}

function CodeBlock({ className, code, lang }: CodeBlockProps) {
	const [copied, setCopied] = useState(false);

	return (
		<div
			style={{
				maxHeight: "300px",
				overflow: "auto",
				background: "var(--mantine-color-dark-7)",
				borderRadius: "4px",
				marginTop: "4px",
				marginBottom: "2px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					position: "sticky",
					top: 0,
					background: "var(--mantine-color-dark-6)",
					padding: "2px 8px",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
					zIndex: 1,
				}}
			>
				{lang ? (
					<Text size="xs" c="gray.6">
						{lang}
					</Text>
				) : (
					<div />
				)}
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => {
						navigator.clipboard.writeText(code).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						});
					}}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ActionIcon>
			</div>
			<pre style={{ padding: "8px", margin: 0 }}>
				<code className={className}>{code}</code>
			</pre>
		</div>
	);
}

function FileAttachment({
	file,
	onPhotoClick,
}: {
	file: FileInfo;
	onPhotoClick?: () => void;
}) {
	const { play, currentTrack, isPlaying } = useAudioPlayer();
	const { activeAccount } = useAuth();
	const token = activeAccount?.token;
	const url = token
		? `${file.url}?token=${encodeURIComponent(token)}`
		: file.url;

	if (file.fileType === "photo") {
		if (onPhotoClick) {
			return (
				<UnstyledButton
					onClick={onPhotoClick}
					style={{ display: "block", padding: 0, lineHeight: 0 }}
				>
					<img
						src={url}
						alt={file.originalName}
						style={{
							maxWidth: "100%",
							maxHeight: 300,
							borderRadius: 6,
							objectFit: "contain",
							cursor: "pointer",
							display: "block",
						}}
					/>
				</UnstyledButton>
			);
		}
		return (
			<a href={url} target="_blank" rel="noreferrer">
				<img
					src={url}
					alt={file.originalName}
					style={{
						maxWidth: "100%",
						maxHeight: 300,
						borderRadius: 6,
						objectFit: "contain",
						cursor: "pointer",
						display: "block",
					}}
				/>
			</a>
		);
	}

	if (file.fileType === "video") {
		return (
			<video
				src={url}
				controls
				preload="metadata"
				style={{
					maxWidth: "100%",
					maxHeight: 300,
					borderRadius: 6,
					display: "block",
				}}
			>
				<track kind="captions" />
			</video>
		);
	}

	if (file.fileType === "audio") {
		const isCurrentTrack = currentTrack?.fileId === file.id;
		const thisIsPlaying = isCurrentTrack && isPlaying;
		const buttonIcon = thisIsPlaying ? "⏸" : "▶";

		return (
			<UnstyledButton
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "6px 10px",
					background: "var(--mantine-color-dark-6)",
					borderRadius: 6,
					width: "100%",
					cursor: "pointer",
				}}
				onClick={() => play({ fileId: file.id, url, name: file.originalName })}
			>
				<Text size="lg">{buttonIcon}</Text>
				<FileAudio size={20} />
				<div style={{ overflow: "hidden", minWidth: 0 }}>
					<Text size="sm" truncate="end">
						{file.originalName}
					</Text>
				</div>
			</UnstyledButton>
		);
	}

	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			style={{ textDecoration: "none" }}
		>
			<UnstyledButton
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					padding: "6px 10px",
					background: "var(--mantine-color-dark-6)",
					borderRadius: 6,
					width: "100%",
					cursor: "pointer",
				}}
			>
				<FileIcon size={24} />
				<div style={{ overflow: "hidden", minWidth: 0 }}>
					<Text size="sm" truncate="end">
						{file.originalName}
					</Text>
					<Text size="xs" c="dimmed">
						{formatSize(file.size)}
					</Text>
				</div>
			</UnstyledButton>
		</a>
	);
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ReplyFilePreview({
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
						width: 24,
						height: 24,
						objectFit: "cover",
						borderRadius: 3,
						flexShrink: 0,
					}}
				/>
			) : (
				<FileIcon
					size={20}
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

function ReplyLocationChip({ location }: { location: Location }) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 4,
				marginTop: 2,
			}}
		>
			<MapPin size={12} style={{ flexShrink: 0 }} />
			<Text size="xs" c="dimmed" truncate="end">
				{formatCoords(location)}
			</Text>
		</div>
	);
}

interface Props {
	text: string;
	isOwn: boolean;
	fromNick?: string;
	time: string;
	chatId: string;
	msgId: string;
	editedAt?: string;
	replyTo?: ReplyToInfo;
	files?: FileInfo[];
	location?: Location;
	onReplyClick?: (messageId: string) => void;
	onStartEdit: (
		chatId: string,
		messageId: string,
		text: string,
		files?: FileInfo[],
		threadId?: string,
	) => void;
	onDelete: (chatId: string, messageId: string) => void;
	onReply?: (chatId: string, messageId: string) => void;
	editTTL: number;
	deleteTTL: number;
	createdAt: string;
	onCreateThread?: (chatId: string, messageId: string) => void;
	onOpenThread?: (threadId: string) => void;
	threadId?: string;
	threadMessageCount?: number;
	isInThread?: boolean;
	status?: "sending" | "failed";
	onRetry?: (chatId: string, messageId: string) => void;
	showAuthorNick?: boolean;
}

function isWithinTTL(createdAt: string, ttl: number): boolean {
	if (ttl === 0) return true;
	if (ttl < 0) return false;
	return (Date.now() - new Date(createdAt).getTime()) / 1000 <= ttl;
}

export function MessageBubble({
	text,
	isOwn,
	fromNick,
	time,
	chatId,
	msgId,
	editedAt,
	replyTo,
	files,
	location,
	onReplyClick,
	onStartEdit,
	onDelete,
	onReply,
	editTTL,
	deleteTTL,
	createdAt,
	onCreateThread,
	onOpenThread,
	threadId,
	threadMessageCount,
	isInThread,
	status,
	onRetry,
	showAuthorNick,
}: Props) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
	const [locationLightboxOpen, setLocationLightboxOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const { t, i18n } = useTranslation();
	const locale = i18n.language.split("-")[0];
	const { activeAccount } = useAuth();
	const token = activeAccount?.token;

	const canEdit =
		isOwn &&
		isWithinTTL(createdAt, editTTL) &&
		status !== "sending" &&
		status !== "failed";
	const canDelete =
		isOwn &&
		(status === "sending" ||
			status === "failed" ||
			isWithinTTL(createdAt, deleteTTL));
	const canReply =
		onReply !== undefined && status !== "sending" && status !== "failed";
	const canCreateThread =
		onCreateThread !== undefined &&
		threadId === undefined &&
		!isInThread &&
		status !== "sending" &&
		status !== "failed";

	const photoFiles = (files ?? []).filter((f) => f.fileType === "photo");

	useLayoutEffect(() => {
		if (!menuPos || !menuRef.current) return;

		const el = menuRef.current;
		const rect = el.getBoundingClientRect();
		if (rect.right > window.innerWidth) {
			el.style.left = `${window.innerWidth - rect.width - 8}px`;
		}
		if (rect.bottom > window.innerHeight) {
			el.style.top = `${window.innerHeight - rect.height - 8}px`;
		}
	}, [menuPos]);

	const editedLabel =
		editedAt !== undefined
			? `${t("message.edited")} ${new Date(editedAt).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`
			: null;

	return (
		<>
			{showAuthorNick === true && !isOwn && fromNick !== undefined && (
				<Text
					size="xs"
					c="dimmed"
					style={{
						alignSelf: "flex-start",
						marginLeft: 8,
						marginBottom: 2,
					}}
				>
					@{fromNick}
				</Text>
			)}
			<Paper
				className={isOwn ? "bubble-own" : "bubble-other"}
				data-message-id={msgId}
				onContextMenu={(e) => {
					e.preventDefault();
					setMenuPos({ x: e.clientX, y: e.clientY });
				}}
				style={{ overflow: "hidden" }}
			>
				{replyTo !== undefined && (
					<UnstyledButton
						style={{
							display: "block",
							width: "100%",
							textAlign: "left",
							marginBottom: 6,
							padding: "2px 6px",
							borderLeft: "3px solid var(--mantine-color-blue-5)",
							background: "var(--mantine-color-dark-6)",
							borderRadius: 4,
							overflow: "hidden",
							cursor: "pointer",
						}}
						onClick={() => onReplyClick?.(replyTo.messageId)}
					>
						<Text size="xs" c="blue" truncate="end">
							@{replyTo.fromNick}
						</Text>
						{replyTo.text.length > 0 ? (
							<Text
								size="xs"
								c="dimmed"
								style={{
									display: "-webkit-box",
									WebkitLineClamp: 2,
									WebkitBoxOrient: "vertical",
									overflow: "hidden",
								}}
							>
								{replyTo.text}
							</Text>
						) : (
							<ReplyFilePreview files={replyTo.files ?? []} token={token} />
						)}
						{replyTo.location !== undefined && (
							<ReplyLocationChip location={replyTo.location} />
						)}
					</UnstyledButton>
				)}
				{(files ?? []).length > 0 && (
					<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
						{files?.map((file) => {
							const photoIdx =
								file.fileType === "photo"
									? photoFiles.findIndex((p) => p.id === file.id)
									: -1;
							return (
								<FileAttachment
									key={file.id}
									file={file}
									onPhotoClick={
										photoIdx >= 0 ? () => setLightboxIdx(photoIdx) : undefined
									}
								/>
							);
						})}
					</div>
				)}
				{location !== undefined && (
					<UnstyledButton
						onClick={() => setLocationLightboxOpen(true)}
						style={{
							display: "block",
							padding: 0,
							marginTop: 4,
							maxWidth: "100%",
						}}
					>
						<LocationMiniMap location={location} />
					</UnstyledButton>
				)}
				{text.length > 0 && (
					<Group gap={6} wrap="nowrap" align="end">
						<div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
							<Markdown
								remarkPlugins={[remarkGfm]}
								components={{
									p: ({ children }) => <span>{children}</span>,
									a: ({ href, children }) => (
										<Anchor href={href} target="_blank" rel="noreferrer">
											{children}
										</Anchor>
									),
									code: ({ className, children }) => {
										const lang = className?.replace("language-", "");
										if (lang) {
											return <code className={className}>{children}</code>;
										}
										return (
											<code
												style={{
													background: "var(--mantine-color-dark-7)",
													padding: "1px 4px",
													borderRadius: "3px",
													fontSize: "0.85em",
												}}
											>
												{children}
											</code>
										);
									},
									pre: ({ children }) => {
										if (!isValidElement(children)) {
											return <pre>{children}</pre>;
										}
										const codeEl = children as React.ReactElement<{
											className?: string;
											children: unknown;
										}>;
										const className = codeEl.props.className ?? "";
										const lang = className.replace("language-", "");
										const codeText = extractCodeText(codeEl.props.children);
										return (
											<CodeBlock
												className={className}
												code={codeText}
												lang={lang}
											/>
										);
									},
								}}
							>
								{text}
							</Markdown>
						</div>
						<Text
							size="xs"
							c="gray.5"
							style={{
								flexShrink: 0,
								display: "flex",
								alignItems: "center",
								gap: 4,
							}}
						>
							{status === "sending" && <Loader size={4} />}
							{status === "failed" && (
								<span
									style={{ color: "var(--mantine-color-red-5)" }}
									title={t("message.failed")}
								>
									!
								</span>
							)}
							{editedLabel ?? time}
						</Text>
					</Group>
				)}
			</Paper>
			{threadId !== undefined && onOpenThread !== undefined && (
				<Button
					variant="subtle"
					color="gray"
					size="compact-xs"
					style={{
						alignSelf: isOwn ? "flex-end" : "flex-start",
						marginTop: 2,
					}}
					onClick={() => onOpenThread(threadId)}
				>
					<MessageCircle size={14} />
					{threadMessageCount !== undefined && threadMessageCount > 0 && (
						<Text component="span" size="xs" ml={2}>
							{threadMessageCount}
						</Text>
					)}
				</Button>
			)}
			{menuPos && (
				<>
					<UnstyledButton
						style={{
							position: "fixed",
							inset: 0,
							zIndex: 999,
							cursor: "default",
						}}
						onClick={() => setMenuPos(null)}
						aria-label="Close menu"
					/>
					<Paper
						ref={menuRef}
						style={{
							position: "fixed",
							left: menuPos.x,
							top: menuPos.y,
							zIndex: 1000,
							minWidth: "140px",
						}}
					>
						<Stack gap={0}>
							<Button
								variant="subtle"
								color="gray"
								fullWidth
								justify="flex-start"
								style={{ borderRadius: 0 }}
								onClick={() => {
									navigator.clipboard.writeText(text);
									setMenuPos(null);
								}}
							>
								<ActionIcon variant="transparent" color="gray" size={18} mr={6}>
									<Copy size={14} />
								</ActionIcon>
								{t("message.copy")}
							</Button>
							{canEdit && (
								<Button
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => {
										onStartEdit(chatId, msgId, text, files, threadId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
										<Pencil size={14} />
									</ActionIcon>
									{t("message.edit")}
								</Button>
							)}
							{status === "failed" && onRetry !== undefined && (
								<Button
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									style={{ borderRadius: 0 }}
									onClick={() => {
										onRetry(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
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
									onClick={() => {
										onReply?.(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
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
									onClick={() => {
										onCreateThread?.(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="gray"
										size={18}
										mr={6}
									>
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
									onClick={() => {
										onDelete(chatId, msgId);
										setMenuPos(null);
									}}
								>
									<ActionIcon
										variant="transparent"
										color="red"
										size={18}
										mr={6}
									>
										<Trash2 size={14} />
									</ActionIcon>
									{t("message.delete")}
								</Button>
							)}
						</Stack>
					</Paper>
				</>
			)}
			{lightboxIdx !== null && photoFiles[lightboxIdx] && (
				<ImageLightbox
					images={photoFiles}
					startIndex={lightboxIdx}
					token={token}
					onClose={() => setLightboxIdx(null)}
				/>
			)}
			{locationLightboxOpen && location !== undefined && (
				<LocationLightbox
					open={locationLightboxOpen}
					location={location}
					editable={false}
					onClose={() => setLocationLightboxOpen(false)}
				/>
			)}
		</>
	);
}
