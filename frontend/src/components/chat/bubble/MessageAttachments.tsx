import { Loader } from "@mantine/core";
import type { FileKey } from "../../../e2ee/file-crypto.ts";
import type { FileInfo } from "../../../types/api.ts";
import { AudioAttachment } from "../AudioAttachment.tsx";
import { FileDownloadAttachment } from "../FileDownloadAttachment.tsx";
import { PhotoAttachment } from "../PhotoAttachment.tsx";
import { VideoAttachment } from "../VideoAttachment.tsx";

interface Props {
	files: FileInfo[];
	fileKeys?: Record<string, FileKey>;
	status?: "sent" | "queued" | "failed";
	onPhotoClick: (idx: number) => void;
}

export function MessageAttachments({
	files,
	fileKeys,
	status,
	onPhotoClick,
}: Props) {
	const photoFiles = files.filter((f) => f.fileType === "photo");

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 6,
				position: "relative",
				opacity: status === "queued" ? 0.6 : 1,
				transition: "opacity 0.2s",
			}}
		>
			{status === "queued" && (
				<div
					style={{
						position: "absolute",
						inset: 0,
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						zIndex: 1,
					}}
				>
					<Loader size="sm" variant="dots" />
				</div>
			)}
			{files.map((file) => {
				const photoIdx =
					file.fileType === "photo"
						? photoFiles.findIndex((p) => p.id === file.id)
						: -1;
				if (file.fileType === "photo") {
					return (
						<PhotoAttachment
							key={file.id}
							file={file}
							fileKeys={fileKeys}
							onPhotoClick={
								photoIdx >= 0 ? () => onPhotoClick(photoIdx) : undefined
							}
						/>
					);
				}
				if (file.fileType === "video") {
					return (
						<VideoAttachment key={file.id} file={file} fileKeys={fileKeys} />
					);
				}
				if (file.fileType === "audio") {
					return (
						<AudioAttachment key={file.id} file={file} fileKeys={fileKeys} />
					);
				}
				return (
					<FileDownloadAttachment
						key={file.id}
						file={file}
						fileKeys={fileKeys}
					/>
				);
			})}
		</div>
	);
}
