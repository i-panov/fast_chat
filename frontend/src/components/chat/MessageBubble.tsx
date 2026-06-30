import { Paper } from "@mantine/core";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { FileInfo, Location, ReplyToInfo } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { getCurrentLocale } from "../../i18n.ts";
import { useAuth } from "../../useAuth.tsx";
import { MessageAttachments } from "./bubble/MessageAttachments.tsx";
import { MessageAuthor } from "./bubble/MessageAuthor.tsx";
import { MessageBody } from "./bubble/MessageBody.tsx";
import { MessageContextMenu } from "./bubble/MessageContextMenu.tsx";
import { MessageLocation } from "./bubble/MessageLocation.tsx";
import { MessageReplyPreview } from "./bubble/MessageReplyPreview.tsx";
import { MessageThreadLink } from "./bubble/MessageThreadLink.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { LocationLightbox } from "./LocationLightbox.tsx";

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
	status?: "sent" | "queued" | "failed";
	onRetry?: (chatId: string, messageId: string) => void;
	showAuthorNick?: boolean;
}

function isWithinTTL(createdAt: string, ttl: number): boolean {
	if (ttl === 0) return true;
	if (ttl < 0) return false;
	return (Date.now() - new Date(createdAt).getTime()) / 1000 <= ttl;
}

function areEqual(prev: Props, next: Props): boolean {
	return (
		prev.text === next.text &&
		prev.isOwn === next.isOwn &&
		prev.fromNick === next.fromNick &&
		prev.time === next.time &&
		prev.chatId === next.chatId &&
		prev.msgId === next.msgId &&
		prev.editedAt === next.editedAt &&
		prev.replyTo === next.replyTo &&
		prev.files === next.files &&
		prev.location === next.location &&
		prev.editTTL === next.editTTL &&
		prev.deleteTTL === next.deleteTTL &&
		prev.createdAt === next.createdAt &&
		prev.threadId === next.threadId &&
		prev.threadMessageCount === next.threadMessageCount &&
		prev.isInThread === next.isInThread &&
		prev.status === next.status &&
		prev.showAuthorNick === next.showAuthorNick
	);
}

export const MessageBubble = memo(function MessageBubble({
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
	const menuButtonRef = useRef<HTMLButtonElement>(null);
	const firstMenuItemRef = useRef<HTMLButtonElement>(null);
	const locale = getCurrentLocale();
	const { activeAccount } = useAuth();

	const replyPhotoFile = replyTo?.files?.[0];
	const replyPhotoUrl =
		replyPhotoFile?.fileType === "photo" ? replyPhotoFile.url : undefined;
	const { blobUrl: replyPhotoBlobUrl } = useFileUrl(
		replyPhotoUrl,
		activeAccount?.token,
	);

	const canEdit =
		isOwn &&
		isWithinTTL(createdAt, editTTL) &&
		status !== "queued" &&
		status !== "failed";
	const canDelete =
		isOwn &&
		(status === "queued" ||
			status === "failed" ||
			isWithinTTL(createdAt, deleteTTL));
	const canReply =
		onReply !== undefined && status !== "queued" && status !== "failed";
	const canCreateThread =
		onCreateThread !== undefined &&
		threadId === undefined &&
		!isInThread &&
		status !== "queued" &&
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

	useEffect(() => {
		if (!menuPos) return;
		firstMenuItemRef.current?.focus();
	}, [menuPos]);

	const closeMenu = useCallback(() => {
		setMenuPos(null);
		menuButtonRef.current?.focus();
	}, []);

	const openMenu = useCallback(() => {
		const btn = menuButtonRef.current;
		if (btn === null) return;
		const rect = btn.getBoundingClientRect();
		setMenuPos({ x: rect.left, y: rect.bottom + 4 });
	}, []);

	useEffect(() => {
		if (!menuPos) return;
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") {
				e.preventDefault();
				closeMenu();
			}
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [menuPos, closeMenu]);

	return (
		<>
			{showAuthorNick === true && !isOwn && fromNick !== undefined && (
				<MessageAuthor nick={fromNick} />
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
					<MessageReplyPreview
						replyTo={replyTo}
						photoBlobUrl={replyPhotoBlobUrl}
						onReplyClick={onReplyClick}
					/>
				)}
				{(files ?? []).length > 0 && (
					<MessageAttachments
						files={files ?? []}
						status={status}
						onPhotoClick={(idx) => setLightboxIdx(idx)}
					/>
				)}
				{location !== undefined && (
					<MessageLocation
						location={location}
						onOpen={() => setLocationLightboxOpen(true)}
					/>
				)}
				<MessageBody
					text={text}
					status={status}
					time={time}
					editedAt={editedAt}
					locale={locale}
					menuOpen={menuPos !== null}
					onMenuToggle={(e) => {
						e.stopPropagation();
						if (menuPos !== null) {
							closeMenu();
						} else {
							openMenu();
						}
					}}
					menuButtonRef={menuButtonRef}
				/>
			</Paper>
			{threadId !== undefined && onOpenThread !== undefined && (
				<MessageThreadLink
					threadId={threadId}
					threadMessageCount={threadMessageCount}
					isOwn={isOwn}
					onOpen={onOpenThread}
				/>
			)}
			<MessageContextMenu
				opened={menuPos !== null}
				position={menuPos ?? { x: 0, y: 0 }}
				canEdit={canEdit}
				canDelete={canDelete}
				canReply={canReply}
				canCreateThread={canCreateThread}
				hasText={text.length > 0}
				status={status}
				onCopy={() => {
					navigator.clipboard.writeText(text);
					closeMenu();
				}}
				onEdit={() => {
					onStartEdit(chatId, msgId, text, files, threadId);
					closeMenu();
				}}
				onRetry={() => {
					onRetry?.(chatId, msgId);
					closeMenu();
				}}
				onReply={() => {
					onReply?.(chatId, msgId);
					closeMenu();
				}}
				onCreateThread={() => {
					onCreateThread?.(chatId, msgId);
					closeMenu();
				}}
				onDelete={() => {
					onDelete(chatId, msgId);
					closeMenu();
				}}
				onClose={closeMenu}
				menuRef={menuRef}
				firstMenuItemRef={firstMenuItemRef}
			/>
			{lightboxIdx !== null && photoFiles[lightboxIdx] && (
				<ImageLightbox
					images={photoFiles}
					startIndex={lightboxIdx}
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
}, areEqual);
