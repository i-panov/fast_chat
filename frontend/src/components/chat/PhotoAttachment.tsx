import { Loader, Text, UnstyledButton } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useDecryptedFileUrl } from "../../hooks/useDecryptedFileUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";

const FILE_ATTACHMENT_MAX_SIZE = 300;

interface Props {
	file: FileInfo;
	fileKeys?: Record<string, FileKey>;
	onPhotoClick?: () => void;
}

export function PhotoAttachment({ file, fileKeys, onPhotoClick }: Props) {
	const { t } = useTranslation();
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
