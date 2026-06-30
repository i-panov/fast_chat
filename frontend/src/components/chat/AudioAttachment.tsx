import { Loader, Text, UnstyledButton } from "@mantine/core";
import { FileAudio } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAudioPlayer } from "../../useAudioPlayer.tsx";
import { useAuth } from "../../useAuth.tsx";

const BORDER_RADIUS_SM = 6;

interface Props {
	file: FileInfo;
}

export function AudioAttachment({ file }: Props) {
	const { t } = useTranslation();
	const { play, currentTrack, isPlaying } = useAudioPlayer();
	const { activeAccount } = useAuth();
	const { blobUrl, loading, error } = useFileUrl(
		file.url,
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
