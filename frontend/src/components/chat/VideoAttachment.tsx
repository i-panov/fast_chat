import { Loader, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { FileKey } from "../../e2ee/file-crypto.ts";
import { useDecryptedFileUrl } from "../../hooks/useDecryptedFileUrl.ts";
import { useMediaUrl } from "../../hooks/useMediaUrl.ts";
import type { FileInfo } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";

const FILE_ATTACHMENT_MAX_SIZE = 300;

interface Props {
	file: FileInfo;
	fileKeys?: Record<string, FileKey>;
}

export function VideoAttachment({ file, fileKeys }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();

	// Use streaming for unencrypted files; decrypt-then-load for encrypted.
	const key = file.hash !== undefined ? fileKeys?.[file.hash] : undefined;
	const decrypted = useDecryptedFileUrl(
		key !== undefined ? file : undefined,
		fileKeys,
		activeAccount?.token,
	);
	const streamed = useMediaUrl(
		key !== undefined ? undefined : file.url,
		activeAccount?.token,
	);

	const mediaUrl = decrypted.blobUrl ?? streamed.mediaUrl;
	const loading = key !== undefined ? decrypted.loading : streamed.loading;
	const error = key !== undefined ? decrypted.error : streamed.error;

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
