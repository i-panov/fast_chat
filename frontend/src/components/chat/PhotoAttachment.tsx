import { Loader, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileInfo } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";

const FILE_ATTACHMENT_MAX_SIZE = 300;
const BORDER_RADIUS_SM = 6;

interface Props {
	file: FileInfo;
	onPhotoClick?: () => void;
}

export function PhotoAttachment({ file, onPhotoClick }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const { blobUrl, loading, error } = useFileUrl(
		file.url,
		activeAccount?.token,
	);

	if (loading) return <Loader size="sm" />;
	if (error || !blobUrl)
		return (
			<Text size="xs" c="red">
				{t("media.loadImageFailed")}
			</Text>
		);

	const imgStyle: React.CSSProperties = {
		maxWidth: "100%",
		maxHeight: FILE_ATTACHMENT_MAX_SIZE,
		borderRadius: BORDER_RADIUS_SM,
		objectFit: "contain",
		cursor: "pointer",
		display: "block",
	};

	if (onPhotoClick) {
		return (
			<UnstyledButton
				onClick={onPhotoClick}
				style={{ display: "block", padding: 0, lineHeight: 0 }}
			>
				<img src={blobUrl} alt={file.originalName} style={imgStyle} />
			</UnstyledButton>
		);
	}
	return (
		<a href={blobUrl} target="_blank" rel="noreferrer">
			<img src={blobUrl} alt={file.originalName} style={imgStyle} />
		</a>
	);
}
