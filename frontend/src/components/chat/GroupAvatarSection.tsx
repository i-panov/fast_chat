import {
	Avatar,
	Button,
	FileButton,
	Group,
	Image,
	Loader,
} from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import type { Chat } from "../../types/api.ts";

interface Props {
	chat: Pick<Chat, "avatarUrl" | "name">;
	token: string | undefined;
	isOwner: boolean;
	onUploadAvatar: (file: File) => void;
}

export function GroupAvatarSection({
	chat,
	token,
	isOwner,
	onUploadAvatar,
}: Props) {
	const { t } = useTranslation();
	const avatarBlobUrlResult = useFileUrl(chat.avatarUrl, token);

	return (
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
						if (file !== null) {
							onUploadAvatar(file);
						}
					}}
					accept="image/png,image/jpeg,image/gif,image/webp"
				>
					{(props) => (
						<Button {...props} variant="default" size="xs">
							{t("chat.uploadAvatar")}
						</Button>
					)}
				</FileButton>
			)}
		</Group>
	);
}
