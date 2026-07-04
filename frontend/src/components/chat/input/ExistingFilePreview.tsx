import { ActionIcon, Loader, Paper, Text } from "@mantine/core";
import { FileIcon, X } from "lucide-react";
import { useFileUrl } from "../../../hooks/useFileUrl.ts";
import type { FileInfo } from "../../../types/api.ts";
import { useAuth } from "../../../useAuth.tsx";
import { BORDER_RADIUS_XS } from "../../../utils/constants.ts";
import { formatSize } from "../../../utils/files.ts";

const PREVIEW_SIZE = 32;
const PENDING_FILE_MAX_WIDTH = 200;

export function ExistingFilePreview({
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
						borderRadius: BORDER_RADIUS_XS,
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
