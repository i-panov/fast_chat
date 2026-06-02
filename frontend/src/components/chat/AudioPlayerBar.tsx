import { ActionIcon, Group, Paper, Text } from "@mantine/core";
import { FileAudio, Pause, Play, X } from "lucide-react";
import { useAudioPlayer } from "../../useAudioPlayer.tsx";

export function AudioPlayerBar() {
	const { currentTrack, isPlaying, toggle, stop } = useAudioPlayer();

	if (currentTrack === null) return null;

	return (
		<Paper
			style={{
				padding: "8px 16px",
				borderRadius: 0,
				borderBottom: "1px solid var(--mantine-color-dark-4)",
				background: "var(--mantine-color-dark-8)",
			}}
		>
			<Group gap="sm" wrap="nowrap">
				<ActionIcon variant="subtle" color="blue" size="sm" onClick={toggle}>
					{isPlaying ? <Pause size={16} /> : <Play size={16} />}
				</ActionIcon>
				<FileAudio size={16} />
				<Text size="sm" truncate="end" style={{ flex: 1, minWidth: 0 }}>
					{currentTrack.name}
				</Text>
				<ActionIcon variant="subtle" color="gray" size="sm" onClick={stop}>
					<X size={16} />
				</ActionIcon>
			</Group>
		</Paper>
	);
}
