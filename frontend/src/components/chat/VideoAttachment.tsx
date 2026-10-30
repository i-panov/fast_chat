/** biome-ignore-all lint/a11y/useMediaCaption: no subtitle tracks exist yet; the placeholder <track> was removed to avoid console warnings. */
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

	// Encrypted iff a decryption key exists (by hash or by file id). A file
	// without a hash must not fall through to plaintext streaming when a key
	// is present — that would feed ciphertext into the player.
	// (useDecryptedFileUrl applies the same hash→id fallback internally.)
	const key =
		(file.hash !== undefined ? fileKeys?.[file.hash] : undefined) ??
		fileKeys?.[file.id];
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
		/>
	);
}
