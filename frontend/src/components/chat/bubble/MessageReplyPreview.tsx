import { Text, UnstyledButton } from "@mantine/core";
import { MapPin } from "lucide-react";
import type { Location, ReplyToInfo } from "../../../types/api.ts";
import { formatCoords } from "../../../utils/chat.ts";
import { BORDER_RADIUS_XS } from "../../../utils/constants.ts";
import { ReplyFilePreviewInline } from "../input/ReplyFilePreviewInline.tsx";

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
				<ReplyFilePreviewInline
					files={replyTo.files ?? []}
					photoBlobUrl={photoBlobUrl}
					imgSize={24}
					iconSize={20}
					borderRadius={BORDER_RADIUS_XS}
				/>
			)}
			{replyTo.location !== undefined && (
				<ReplyLocationChip location={replyTo.location} />
			)}
		</UnstyledButton>
	);
}
