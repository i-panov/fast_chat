import { Loader, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../api.ts";
import { useMediaUrl } from "../../hooks/useMediaUrl.ts";
import { useAuth } from "../../useAuth.tsx";

const FILE_ATTACHMENT_MAX_SIZE = 300;
const BORDER_RADIUS_SM = 6;

interface Props {
	file: FileInfo;
}

export function VideoAttachment({ file }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const { mediaUrl, loading, error } = useMediaUrl(
		file.url,
		activeAccount?.token,
	);

	if (loading) return <Loader size="sm" />;
	if (error || !mediaUrl)
		return (
			<Text size="xs" c="red">
				{t("media.loadVideoFailed")}
			</Text>
		);

	return (
		<video
			src={mediaUrl}
			controls
			preload="metadata"
			style={{
				maxWidth: "100%",
				maxHeight: FILE_ATTACHMENT_MAX_SIZE,
				borderRadius: BORDER_RADIUS_SM,
				display: "block",
			}}
		>
			<track kind="captions" />
		</video>
	);
}
