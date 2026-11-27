import {
	Avatar,
	Button,
	FileButton,
	Group,
	Image,
	Loader,
	Stack,
	Text,
} from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { Chat } from "../../types/api.ts";

// The server accepts up to 50 MB, but every member has to download the
// avatar: a small client limit keeps group rows light.
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface Props {
	chat: Pick<Chat, "avatarUrl" | "name">;
	token: string | undefined;
	isOwner: boolean;
	onUploadAvatar: (file: File) => void | Promise<void>;
}

export function GroupAvatarSection({
	chat,
	token,
	isOwner,
	onUploadAvatar,
}: Props) {
	const { t } = useTranslation();
	const avatarBlobUrlResult = useFileUrl(chat.avatarUrl, token);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleFile(file: File | null) {
		if (file === null || busy) return;
		if (!file.type.startsWith("image/")) {
			setError(t("error.imageType"));
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setError(t("error.imageTooLarge"));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onUploadAvatar(file);
		} catch (err) {
			setError(
				t(
					err instanceof ApiError && err.status === 403
						? "error.forbidden"
						: "error.requestFailed",
				),
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Stack gap={4}>
			<Group gap="md" align="center">
				{chat.avatarUrl !== undefined &&
				chat.avatarUrl !== "" &&
				avatarBlobUrlResult.blobUrl ? (
					<Image
						src={avatarBlobUrlResult.blobUrl}
						alt={t("chat.avatarAlt")}
						w={64}
						h={64}
						radius="xl"
						fit="cover"
					/>
				) : chat.avatarUrl !== undefined &&
					chat.avatarUrl !== "" &&
					avatarBlobUrlResult.loading ? (
					<Loader size="lg" />
				) : (
					<Avatar size={64} radius="xl" color="blue">
						{chat.name.charAt(0).toUpperCase() || "#"}
					</Avatar>
				)}
				{isOwner && (
					<FileButton
						onChange={(file) => {
							void handleFile(file);
						}}
						accept="image/png,image/jpeg,image/gif,image/webp"
					>
						{(props) => (
							<Button {...props} variant="default" size="xs" loading={busy}>
								{t("chat.uploadAvatar")}
							</Button>
						)}
					</FileButton>
				)}
			</Group>
			{error !== null && (
				<Text size="xs" c="red" role="alert">
					{error}
				</Text>
			)}
		</Stack>
	);
}
