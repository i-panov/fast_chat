// The bubble composes content, menu, selection, reactions and lightboxes.
/* eslint-disable max-lines */
import { Paper } from "@mantine/core";
import { CheckCircle2, Circle } from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useMessageSelection } from "../../context/MessageSelectionContext.tsx";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { getCurrentLocale } from "../../i18n.ts";
import type {
	FileInfo,
	InlineKeyboardMarkup,
	Location,
	MessageDeliveryStatus,
	ReactionSummary,
	ReplyToInfo,
} from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { copyImageToClipboard } from "../../utils/clipboardImage.ts";
import { InlineKeyboard } from "./bubble/InlineKeyboard.tsx";
import { MessageAttachments } from "./bubble/MessageAttachments.tsx";
import { MessageAuthor } from "./bubble/MessageAuthor.tsx";
import { MessageBody } from "./bubble/MessageBody.tsx";
import { BubbleContextMenu } from "./bubble/MessageBubbleMenu.tsx";
import { MessageLocation } from "./bubble/MessageLocation.tsx";
import { MessageReplyPreview } from "./bubble/MessageReplyPreview.tsx";
import { MessageThreadLink } from "./bubble/MessageThreadLink.tsx";
import { ReactionBar } from "./bubble/ReactionBar.tsx";
import { ImageLightbox } from "./ImageLightbox.tsx";
import { LocationLightbox } from "./LocationLightbox.tsx";

export interface MessageBubbleProps {
	text: string;
	isOwn: boolean;
	fromNick?: string;
	fromId?: string;
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
	onPin?: (chatId: string, messageId: string) => void;
	isPinned?: boolean;
	onBlock?: (fromId: string) => void;
	onForward?: (chatId: string, messageId: string) => void;
	// linkThreadId points at the thread started by this message (the "N replies"
	// link); messageThreadId is the thread that contains the message itself and
	// addresses edit/reaction storage.
	linkThreadId?: string;
	messageThreadId?: string;
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
	reactions?: ReactionSummary[];
	replyMarkup?: InlineKeyboardMarkup;
}

function isWithinTTL(
	createdAt: string,
	ttl: number,
	now = Date.now(),
): boolean {
	if (ttl === 0) return true;
	if (ttl < 0) return false;
	return (now - new Date(createdAt).getTime()) / 1000 <= ttl;
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
		prev.fromId === next.fromId &&
		prev.time === next.time &&
		prev.chatId === next.chatId &&
		prev.msgId === next.msgId &&
		prev.editedAt === next.editedAt &&
		prev.editTTL === next.editTTL &&
		prev.deleteTTL === next.deleteTTL &&
		prev.createdAt === next.createdAt &&
		prev.linkThreadId === next.linkThreadId &&
		prev.messageThreadId === next.messageThreadId &&
		prev.threadMessageCount === next.threadMessageCount &&
		prev.isInThread === next.isInThread &&
		prev.status === next.status &&
		prev.deliveryStatus === next.deliveryStatus &&
		prev.showAuthorNick === next.showAuthorNick &&
		prev.isPinned === next.isPinned &&
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
		deepEq(prev.fileKeys, next.fileKeys) &&
		deepEq(prev.reactions, next.reactions) &&
		deepEq(prev.replyMarkup, next.replyMarkup)
	);
}

// fileKeys must stay in the comparison so a message stuck in
// failed/encrypted state re-renders once keys arrive.

// Callbacks are compared by reference: a parent that closes over stale data
// (MessageList.handleReplyClick over datedMessages) must be able to update the
// bubble after history arrives. The other handlers are stable useCallbacks, so
// the reference check does not defeat memo.
function callbacksEqual(
	prev: MessageBubbleProps,
	next: MessageBubbleProps,
): boolean {
	return (
		prev.onReplyClick === next.onReplyClick &&
		prev.onStartEdit === next.onStartEdit &&
		prev.onDelete === next.onDelete &&
		prev.onReply === next.onReply &&
		prev.onCreateThread === next.onCreateThread &&
		prev.onOpenThread === next.onOpenThread &&
		prev.onPin === next.onPin &&
		prev.onBlock === next.onBlock &&
		prev.onForward === next.onForward &&
		prev.onRetry === next.onRetry &&
		prev.onCancelSend === next.onCancelSend
	);
}

function areEqual(prev: MessageBubbleProps, next: MessageBubbleProps): boolean {
	return (
		primitivePropsEqual(prev, next) &&
		deepPropsEqual(prev, next) &&
		callbacksEqual(prev, next)
	);
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
	fileKeys,
}: {
	photoFiles: FileInfo[];
	lightboxIdx: number | null;
	setLightboxIdx: (idx: number | null) => void;
	location?: Location;
	locationLightboxOpen: boolean;
	setLocationLightboxOpen: (open: boolean) => void;
	fileKeys?: Record<string, FileKey>;
}) {
	return (
		<>
			{lightboxIdx !== null && photoFiles[lightboxIdx] && (
				<ImageLightbox
					images={photoFiles}
					startIndex={lightboxIdx}
					fileKeys={fileKeys}
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

// The bubble keeps its layout and menu wiring together; splitting it would
// scatter the action callbacks.
// eslint-disable-next-line max-lines-per-function, complexity
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
	onPin,
	isPinned = false,
	onBlock,
	onForward,
	fromId = "",
	linkThreadId,
	messageThreadId,
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
	reactions,
	replyMarkup,
}: MessageBubbleProps) {
	const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
	// TTL gates (edit/delete) are evaluated when the menu opens: the bubble memo
	// blocks a re-render on a timer, so a stale render would keep offering
	// actions after the window expired.
	const [menuOpenedAt, setMenuOpenedAt] = useState<number | null>(null);
	// A component that mounts later than the render (memo hit) still needs a
	// "now" for the TTL gate; the value is fixed once per mount.
	const [mountedAt] = useState(() => Date.now());
	const bubbleRef = useRef<HTMLDivElement>(null);
	const menuOpenedByKeyboardRef = useRef(false);
	const longPressTimerRef = useRef<number | null>(null);
	const longPressStartRef = useRef<{ x: number; y: number } | null>(null);
	const longPressFiredRef = useRef(false);
	const [lightboxIdx, setLightboxIdx] = useState<number | null>(null);
	const [locationLightboxOpen, setLocationLightboxOpen] = useState(false);
	const menuRef = useRef<HTMLDivElement>(null);
	const firstMenuItemRef = useRef<HTMLButtonElement>(null);
	const locale = getCurrentLocale();
	const { activeAccount } = useAuth();
	const selection = useMessageSelection();

	const replyPhotoFile = replyTo?.files?.[0];
	const replyPhotoUrl =
		replyPhotoFile?.fileType === "photo" ? replyPhotoFile.url : undefined;
	const { blobUrl: replyPhotoBlobUrl } = useFileUrl(
		replyPhotoUrl,
		activeAccount?.token,
	);

	const ttlNow = menuOpenedAt ?? mountedAt;
	const canEdit =
		isOwn &&
		isWithinTTL(createdAt, editTTL, ttlNow) &&
		status !== "queued" &&
		status !== "failed";
	const canDelete =
		isOwn &&
		(status === "queued" ||
			status === "failed" ||
			isWithinTTL(createdAt, deleteTTL, ttlNow));
	const canCancelSend = onCancelSend !== undefined && status === "queued";
	const canReply =
		onReply !== undefined && status !== "queued" && status !== "failed";
	const canPin =
		onPin !== undefined && status !== "queued" && status !== "failed";

	const photoFiles = (files ?? []).filter((f) => f.fileType === "photo");
	const firstPhoto = photoFiles[0];
	const copyPhoto = async () => {
		if (firstPhoto === undefined) return;
		// A local blob is the plaintext itself: a key for the hash exists on
		// an encrypted message, but decrypting those bytes would fail.
		const key = firstPhoto.url.startsWith("blob:")
			? undefined
			: ((firstPhoto.hash !== undefined
					? fileKeys?.[firstPhoto.hash]
					: undefined) ?? fileKeys?.[firstPhoto.id]);
		await copyImageToClipboard(firstPhoto, key, activeAccount?.token);
	};

	const canForward =
		onForward !== undefined &&
		status !== "queued" &&
		status !== "failed" &&
		undecryptable !== true &&
		(text.trim() !== "" || (files ?? []).length > 0);
	const canBlock =
		!isOwn &&
		fromId !== "" &&
		onBlock !== undefined &&
		status !== "queued" &&
		status !== "failed";
	const canCreateThread =
		onCreateThread !== undefined &&
		linkThreadId === undefined &&
		!isInThread &&
		status !== "queued" &&
		status !== "failed";
	const selectable = selection?.mode === true && canDelete;
	const selected = selection?.selected.has(msgId) === true;
	const hasMenuActions =
		canEdit ||
		canDelete ||
		canCancelSend ||
		canReply ||
		canCreateThread ||
		canPin ||
		canBlock ||
		canForward;

	useEffect(() => {
		if (!menuPos) return;
		firstMenuItemRef.current?.focus();
	}, [menuPos]);

	const clearLongPress = useCallback(() => {
		if (longPressTimerRef.current !== null) {
			window.clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
		longPressStartRef.current = null;
	}, []);

	useEffect(() => clearLongPress, [clearLongPress]);

	const closeMenu = useCallback(() => {
		setMenuPos(null);
		setMenuOpenedAt(null);
		if (menuOpenedByKeyboardRef.current) {
			menuOpenedByKeyboardRef.current = false;
			// The trigger is the bubble itself: the opened menu took focus,
			// and closing it must hand focus back for continued keyboard use.
			requestAnimationFrame(() => bubbleRef.current?.focus());
		}
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
		setMenuOpenedAt(Date.now());
		setMenuPos({ x, y });
	}

	// iOS Safari does not emit contextmenu for a long tap on a plain div, so
	// touch users get the same menu through a pointer long-press. Scrolling
	// (movement) or releasing early cancels it instead of opening the menu.
	function startLongPress(e: React.PointerEvent<HTMLDivElement>) {
		if (selection?.mode) return;
		if (e.pointerType === "mouse") return;
		clearLongPress();
		longPressFiredRef.current = false;
		longPressStartRef.current = { x: e.clientX, y: e.clientY };
		const { clientX, clientY } = e;
		longPressTimerRef.current = window.setTimeout(() => {
			longPressTimerRef.current = null;
			longPressFiredRef.current = true;
			menuOpenedByKeyboardRef.current = false;
			openMenuAt(clientX, clientY);
		}, 500);
	}

	function moveLongPress(e: React.PointerEvent<HTMLDivElement>) {
		const start = longPressStartRef.current;
		if (start === null) return;
		if (
			Math.abs(e.clientX - start.x) > 10 ||
			Math.abs(e.clientY - start.y) > 10
		) {
			clearLongPress();
		}
	}

	return (
		<>
			<BubbleAuthor
				showAuthorNick={showAuthorNick}
				isOwn={isOwn}
				fromNick={fromNick}
			/>
			<div
				style={{
					position: "relative",
					display: "flex",
					maxWidth: "min(70%, 640px)",
					minWidth: 0,
				}}
			>
				<Paper
					ref={bubbleRef}
					className={isOwn ? "bubble-own" : "bubble-other"}
					data-message-id={msgId}
					onClickCapture={(e) => {
						if (!selection?.mode) return;
						e.preventDefault();
						e.stopPropagation();
						if (canDelete) selection.toggle(msgId);
					}}
					onContextMenu={(e) => {
						e.preventDefault();
						if (selection?.mode) return;
						clearLongPress();
						menuOpenedByKeyboardRef.current = false;
						openMenuAt(e.clientX, e.clientY);
					}}
					onPointerDown={startLongPress}
					onPointerMove={moveLongPress}
					onPointerUp={clearLongPress}
					onPointerCancel={clearLongPress}
					onPointerLeave={clearLongPress}
					aria-haspopup={hasMenuActions ? "menu" : undefined}
					tabIndex={hasMenuActions || selectable ? 0 : undefined}
					onKeyDown={(e) => {
						if (selection?.mode) {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								if (canDelete) selection.toggle(msgId);
							}

							return;
						}
						// The three-dot trigger is gone: keyboard users get the
						// same menu with the context-menu key or Shift+F10.
						if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) {
							return;
						}
						e.preventDefault();
						menuOpenedByKeyboardRef.current = true;
						const rect = e.currentTarget.getBoundingClientRect();
						openMenuAt(rect.left, rect.bottom);
					}}
					style={{
						overflow: "hidden",
						maxWidth: "100%",
						minWidth: 0,
						outline: selected
							? "2px solid var(--mantine-color-blue-5)"
							: undefined,
						outlineOffset: selected ? -2 : undefined,
					}}
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
					{replyMarkup !== undefined && (
						<InlineKeyboard
							chatId={chatId}
							messageId={msgId}
							markup={replyMarkup}
						/>
					)}
				</Paper>
				{selection?.mode === true && canDelete && (
					<div
						style={{
							position: "absolute",
							top: 6,
							right: 6,
							zIndex: 2,
							borderRadius: "50%",
							background: "var(--mantine-color-dark-8)",
							display: "flex",
							// The visible check must not swallow the tap: the
							// Paper's capture handler owns the toggle.
							pointerEvents: "none",
						}}
					>
						{selected ? (
							<CheckCircle2
								size={18}
								color="var(--mantine-color-blue-5)"
								aria-hidden="true"
							/>
						) : (
							<Circle
								size={18}
								color="var(--mantine-color-gray-5)"
								aria-hidden="true"
							/>
						)}
					</div>
				)}
			</div>
			<ReactionBar
				chatId={chatId}
				messageId={msgId}
				reactions={reactions}
				threadId={messageThreadId}
				disabled={status === "queued" || status === "failed"}
			/>
			<BubbleThreadLink
				threadId={linkThreadId}
				threadMessageCount={threadMessageCount}
				isOwn={isOwn}
				onOpenThread={onOpenThread}
			/>
			<BubbleContextMenu
				menuPos={menuPos}
				canEdit={canEdit}
				canDelete={canDelete}
				canSelect={selection !== null && canDelete}
				canCancelSend={canCancelSend}
				canReply={canReply}
				canCreateThread={canCreateThread}
				canPin={canPin}
				isPinned={isPinned}
				canBlock={canBlock}
				canForward={canForward}
				status={status}
				text={text}
				hasImage={photoFiles.length > 0}
				onCopyImage={copyPhoto}
				chatId={chatId}
				msgId={msgId}
				fromId={fromId}
				files={files}
				threadId={messageThreadId}
				onStartEdit={onStartEdit}
				onRetry={onRetry}
				onCancelSend={onCancelSend}
				onReply={onReply}
				onCreateThread={onCreateThread}
				onPin={onPin}
				onBlock={onBlock}
				onForward={onForward}
				onDelete={onDelete}
				onSelect={() => selection?.start(msgId)}
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
				fileKeys={fileKeys}
			/>
		</>
	);
}, areEqual);
