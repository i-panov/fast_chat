import { Loader, Text, UnstyledButton } from "@mantine/core";
import { FileAudio } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useAudioWaveform } from "../../hooks/useAudioWaveform.ts";
import { useDecryptedFileUrl } from "../../hooks/useDecryptedFileUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAudioPlayer } from "../../useAudioPlayer.tsx";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";

const VOICE_NAME_RE = /^voice-(\d+)s\./;
const VOICE_PREFIX_RE = /^voice-\d+s\./;
// The waveform is computed only for a voice message: decoding a long music
// track on every mount is an out-of-memory risk on a phone.
const IS_VOICE_RE = /^voice-\d+s\./;

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
	const peaks = useAudioWaveform(
		IS_VOICE_RE.test(file.originalName) ? blobUrl : null,
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
	const voiceDuration = VOICE_NAME_RE.exec(file.originalName)?.[1];

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
			{peaks !== null ? (
				<div
					style={{
						display: "flex",
						alignItems: "center",
						gap: 2,
						height: 22,
						flexShrink: 0,
					}}
				>
					{peaks.map((peak, index) => {
						const key = `${index}-${peak}`;
						return (
							<div
								key={key}
								style={{
									width: 2,
									height: Math.max(2, Math.round(peak * 22)),
									borderRadius: 1,
									background: "var(--mantine-color-blue-5)",
								}}
							/>
						);
					})}
				</div>
			) : (
				<FileAudio size={20} />
			)}
			<div style={{ overflow: "hidden", minWidth: 0 }}>
				<Text size="sm" truncate="end">
					{voiceDuration !== undefined
						? `${file.originalName.replace(VOICE_PREFIX_RE, "")} · ${voiceDuration}s`
						: file.originalName}
				</Text>
			</div>
		</UnstyledButton>
	);
}
