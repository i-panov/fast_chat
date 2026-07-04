import { ActionIcon, Loader, Paper, Text } from "@mantine/core";
import { FileIcon, X } from "lucide-react";
import { useVideoThumbnail } from "../../../hooks/useVideoThumbnail.ts";
import type { PendingFile } from "../../../types/api.ts";
import { BORDER_RADIUS_XS } from "../../../utils/constants.ts";
import { formatSize } from "../../../utils/files.ts";

const PREVIEW_SIZE = 32;
const PENDING_FILE_MAX_WIDTH = 200;

export function PendingFilePreview({
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
						borderRadius: BORDER_RADIUS_XS,
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
							borderRadius: BORDER_RADIUS_XS,
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
							borderRadius: BORDER_RADIUS_XS,
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
