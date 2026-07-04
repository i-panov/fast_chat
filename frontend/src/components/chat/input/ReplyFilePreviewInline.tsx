import { Loader, Text } from "@mantine/core";
import { FileIcon } from "lucide-react";
import type { FileInfo } from "../../../types/api.ts";

export function ReplyFilePreviewInline({
	files,
	photoBlobUrl,
	imgSize = 20,
	iconSize = 18,
	borderRadius = 3,
}: {
	files: FileInfo[];
	photoBlobUrl: string | null;
	imgSize?: number;
	iconSize?: number;
	borderRadius?: number;
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
						width: imgSize,
						height: imgSize,
						objectFit: "cover",
						borderRadius,
						flexShrink: 0,
					}}
				/>
			) : first.fileType === "photo" ? (
				<Loader size="xs" />
			) : (
				<FileIcon
					size={iconSize}
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
