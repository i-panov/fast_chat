import { Loader, Text, UnstyledButton } from "@mantine/core";
import { FileIcon, MapPin } from "lucide-react";
import type { FileInfo, Location, ReplyToInfo } from "../../../api.ts";
import { formatCoords } from "../../../utils/chat.ts";

const BORDER_RADIUS_XS = 4;

function ReplyFilePreview({
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
						width: 24,
						height: 24,
						objectFit: "cover",
						borderRadius: BORDER_RADIUS_XS,
						flexShrink: 0,
					}}
				/>
			) : first.fileType === "photo" ? (
				<Loader size="xs" />
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
	replyTo: ReplyToInfo;
	photoBlobUrl: string | null;
	onReplyClick?: (messageId: string) => void;
}

export function MessageReplyPreview({
	replyTo,
	photoBlobUrl,
	onReplyClick,
}: Props) {
	return (
		<UnstyledButton
			style={{
				display: "block",
				width: "100%",
				textAlign: "left",
				marginBottom: 6,
				padding: "2px 6px",
				borderLeft: "3px solid var(--mantine-color-blue-5)",
				background: "var(--mantine-color-dark-6)",
				borderRadius: BORDER_RADIUS_XS,
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
				<ReplyFilePreview
					files={replyTo.files ?? []}
					photoBlobUrl={photoBlobUrl}
				/>
			)}
			{replyTo.location !== undefined && (
				<ReplyLocationChip location={replyTo.location} />
			)}
		</UnstyledButton>
	);
}
