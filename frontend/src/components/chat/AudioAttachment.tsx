import { Loader, Text, UnstyledButton } from "@mantine/core";
import { FileAudio } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useDecryptedFileUrl } from "../../hooks/useDecryptedFileUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAudioPlayer } from "../../useAudioPlayer.tsx";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";

interface Props {
	file: FileInfo;
	fileKeys?: Record<string, FileKey>;
}

export function AudioAttachment({ file, fileKeys }: Props) {
	const { t } = useTranslation();
	const { play, currentTrack, isPlaying } = useAudioPlayer();
	const { activeAccount } = useAuth();
	const { blobUrl, loading, error } = useDecryptedFileUrl(
		file,
		fileKeys,
		activeAccount?.token,
	);

	if (loading) return <Loader size="sm" />;
	if (error || !blobUrl)
		return (
			<Text size="xs" c="red">
				{t("media.loadAudioFailed")}
			</Text>
		);

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
				borderRadius: BORDER_RADIUS_SM,
				width: "100%",
				cursor: "pointer",
			}}
			onClick={() =>
				play({ fileId: file.id, url: blobUrl, name: file.originalName })
			}
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
