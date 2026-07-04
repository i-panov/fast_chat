import { Loader, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useMediaUrl } from "../../hooks/useMediaUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";

const FILE_ATTACHMENT_MAX_SIZE = 300;

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
