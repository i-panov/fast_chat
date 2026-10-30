import { Paper } from "@mantine/core";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { getCurrentLocale } from "../../i18n.ts";
import type {
	FileInfo,
	Location,
	MessageDeliveryStatus,
	ReplyToInfo,
} from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { MessageAttachments } from "./bubble/MessageAttachments.tsx";
import { MessageAuthor } from "./bubble/MessageAuthor.tsx";
import { MessageBody } from "./bubble/MessageBody.tsx";
import {
	BubbleContextMenu,
	MessageMenuButton,
} from "./bubble/MessageBubbleMenu.tsx";
import { MessageLocation } from "./bubble/MessageLocation.tsx";
import { MessageReplyPreview } from "./bubble/MessageReplyPreview.tsx";
import { MessageThreadLink } from "./bubble/MessageThreadLink.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { LocationLightbox } from "./LocationLightbox.tsx";

export interface MessageBubbleProps {
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
	onDelete: (chatId: string, messageId: string) => void | Promise<void>;
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
	deliveryStatus?: MessageDeliveryStatus;
	onRetry?: (chatId: string, messageId: string) => void | Promise<void>;
	onCancelSend?: (chatId: string, messageId: string) => void;
	showAuthorNick?: boolean;
	encrypted?: boolean;
	undecryptable?: boolean;
	// fileKeys maps file ID to decryption key for encrypted files.
	fileKeys?: Record<string, FileKey>;
}

function isWithinTTL(createdAt: string, ttl: number): boolean {
	if (ttl === 0) return true;
	if (ttl < 0) return false;
	return (Date.now() - new Date(createdAt).getTime()) / 1000 <= ttl;
}

function deepEq(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a == null || b == null) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return false;
		return a.every((v, i) => deepEq(v, b[i]));
	}
	if (typeof a === "object" && typeof b === "object") {
		const ka = Object.keys(a);
		const kb = Object.keys(b);
		if (ka.length !== kb.length) return false;
		return ka.every((k) =>
			deepEq(
				(a as Record<string, unknown>)[k],
				(b as Record<string, unknown>)[k],
			),
		);
	}
	return false;
}

function primitivePropsEqual(
	prev: MessageBubbleProps,
	next: MessageBubbleProps,
): boolean {
	return (
		prev.text === next.text &&
		prev.isOwn === next.isOwn &&
		prev.fromNick === next.fromNick &&
		prev.time === next.time &&
		prev.chatId === next.chatId &&
		prev.msgId === next.msgId &&
		prev.editedAt === next.editedAt &&
		prev.editTTL === next.editTTL &&
		prev.deleteTTL === next.deleteTTL &&
		prev.createdAt === next.createdAt &&
		prev.threadId === next.threadId &&
		prev.threadMessageCount === next.threadMessageCount &&
		prev.isInThread === next.isInThread &&
		prev.status === next.status &&
		prev.deliveryStatus === next.deliveryStatus &&
		prev.showAuthorNick === next.showAuthorNick &&
		prev.encrypted === next.encrypted &&
		prev.undecryptable === next.undecryptable
	);
}

function deepPropsEqual(
	prev: MessageBubbleProps,
	next: MessageBubbleProps,
): boolean {
	return (
		deepEq(prev.replyTo, next.replyTo) &&
		deepEq(prev.files, next.files) &&
		deepEq(prev.location, next.location) &&
		deepEq(prev.fileKeys, next.fileKeys)
	);
}

// Callbacks (onReply/onDelete/...) are intentionally excluded: parents pass
// stable useCallback handlers, and comparing by reference would defeat the
// memo on every render. fileKeys must stay in the comparison so a message
// stuck in failed/encrypted state re-renders once keys arrive.

function areEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
	return primitivePropsEqual(prev, next) && deepPropsEqual(prev, next);
}

function BubbleAuthor({
	showAuthorNick,
	isOwn,
	fromNick,
}: {
	showAuthorNick?: boolean;
	isOwn: boolean;
	fromNick?: string;
}) {
	if (showAuthorNick !== true || isOwn || fromNick === undefined) return null;
	return <MessageAuthor nick={fromNick} />;
}

function BubbleContent({
	replyTo,
	photoBlobUrl,
	onReplyClick,
	files,
	fileKeys,
	status,
	onPhotoClick,
	location,
	onOpenLocation,
}: {
	replyTo?: ReplyToInfo;
	photoBlobUrl: string | null;
	onReplyClick?: (messageId: string) => void;
	files?: FileInfo[];
	fileKeys?: Record<string, FileKey>;
	status?: "sent" | "queued" | "failed";
	onPhotoClick: (idx: number) => void;
	location?: Location;
	onOpenLocation: () => void;
}) {
	return (
		<>
			{replyTo !== undefined && (
				<MessageReplyPreview
					replyTo={replyTo}
					photoBlobUrl={photoBlobUrl}
					onReplyClick={onReplyClick}
				/>
			)}
			{(files ?? []).length > 0 && (
				<MessageAttachments
					files={files ?? []}
					fileKeys={fileKeys}
					status={status}
					onPhotoClick={onPhotoClick}
				/>
			)}
			{location !== undefined && (
				<MessageLocation location={location} onOpen={onOpenLocation} />
			)}
		</>
	);
}

function BubbleThreadLink({
	threadId,
	threadMessageCount,
	isOwn,
	onOpenThread,
}: {
	threadId?: string;
	threadMessageCount?: number;
	isOwn: boolean;
	onOpenThread?: (threadId: string) => void;
}) {
	if (threadId === undefined || onOpenThread === undefined) return null;
	return (
		<MessageThreadLink
			threadId={threadId}
			threadMessageCount={threadMessageCount}
			isOwn={isOwn}
			onOpen={onOpenThread}
		/>
	);
}

function BubbleLightboxes({
	photoFiles,
	lightboxIdx,
	setLightboxIdx,
	location,
	locationLightboxOpen,
	setLocationLightboxOpen,
}: {
	photoFiles: FileInfo[];
	lightboxIdx: number | null;
	setLightboxIdx: (idx: number | null) => void;
	location?: Location;
	locationLightboxOpen: boolean;
	setLocationLightboxOpen: (open: boolean) => void;
}) {
	return (
		<>
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
	deliveryStatus,
	onRetry,
	onCancelSend,
	showAuthorNick,
	encrypted,
	undecryptable,
	fileKeys,
}: MessageBubbleProps) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
	const [locationLightboxOpen, setLocationLightboxOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
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
	const canCancelSend = onCancelSend !== undefined && status === "queued";
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

	function openMenuAt(x: number, y: number) {
		setMenuPos({ x, y });
	}

	return (
		<>
			<BubbleAuthor
				showAuthorNick={showAuthorNick}
				isOwn={isOwn}
				fromNick={fromNick}
			/>
			<div style={{ position: "relative", maxWidth: "100%", display: "flex" }}>
				<Paper
					className={isOwn ? "bubble-own" : "bubble-other"}
					data-message-id={msgId}
					onContextMenu={(e) => {
						e.preventDefault();
						openMenuAt(e.clientX, e.clientY);
					}}
					style={{ overflow: "hidden", flex: 1 }}
				>
					<BubbleContent
						replyTo={replyTo}
						photoBlobUrl={replyPhotoBlobUrl}
						onReplyClick={onReplyClick}
						files={files}
						fileKeys={fileKeys}
						status={status}
						onPhotoClick={setLightboxIdx}
						location={location}
						onOpenLocation={() => setLocationLightboxOpen(true)}
					/>
					<MessageBody
						text={text}
						status={status}
						deliveryStatus={deliveryStatus}
						isOwn={isOwn}
						time={time}
						editedAt={editedAt}
						locale={locale}
						encrypted={encrypted}
						undecryptable={undecryptable}
					/>
				</Paper>
				<MessageMenuButton onOpen={openMenuAt} />
			</div>
			<BubbleThreadLink
				threadId={threadId}
				threadMessageCount={threadMessageCount}
				isOwn={isOwn}
				onOpenThread={onOpenThread}
			/>
			<BubbleContextMenu
				menuPos={menuPos}
				canEdit={canEdit}
				canDelete={canDelete}
				canCancelSend={canCancelSend}
				canReply={canReply}
				canCreateThread={canCreateThread}
				status={status}
				text={text}
				chatId={chatId}
				msgId={msgId}
				files={files}
				threadId={threadId}
				onStartEdit={onStartEdit}
				onRetry={onRetry}
				onCancelSend={onCancelSend}
				onReply={onReply}
				onCreateThread={onCreateThread}
				onDelete={onDelete}
				onClose={closeMenu}
				menuRef={menuRef}
				firstMenuItemRef={firstMenuItemRef}
			/>
			<BubbleLightboxes
				photoFiles={photoFiles}
				lightboxIdx={lightboxIdx}
				setLightboxIdx={setLightboxIdx}
				location={location}
				locationLightboxOpen={locationLightboxOpen}
				setLocationLightboxOpen={setLocationLightboxOpen}
			/>
		</>
	);
}, areEqual);
