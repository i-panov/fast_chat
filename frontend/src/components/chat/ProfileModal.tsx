import {
	Alert,
	Avatar,
	Button,
	FileButton,
	Group,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, uploadFile, uploadUserAvatar } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
	user: { id: string; nick: string; avatarUrl?: string } | null;
}

function avatarErrorKey(error: unknown): string {
	if (error instanceof ApiError && error.status === 413) {
		return "error.imageTooLarge";
	}
	if (error instanceof ApiError && error.status === 403) {
		return "error.forbidden";
	}

	return "error.requestFailed";
}

export function ProfileModal({ open, onClose, token, user }: Props) {
	const { t } = useTranslation();
	const { updateAccountUser } = useAuth();
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const { blobUrl, loading } = useFileUrl(user?.avatarUrl, token);
	const [busy, setBusy] = useState<"upload" | "remove" | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function upload(file: File | null) {
		if (file === null || token === undefined || user === null || busy) return;
		// The server rejects non-images after the whole file was uploaded:
		// validate locally so nothing is stored and the error is localized.
		if (!file.type.startsWith("image/")) {
			setError(t("error.imageType"));
			return;
		}
		if (file.size > MAX_AVATAR_BYTES) {
			setError(t("error.imageTooLarge"));
			return;
		}
		setBusy("upload");
		setError(null);
		try {
			const uploaded = await uploadFile(token, file);
			const result = await uploadUserAvatar(token, uploaded.file.id);
			updateAccountUser({
				id: user.id,
				nick: result.user.nick,
				avatarUrl: result.user.avatarUrl,
			});
		} catch (err) {
			setError(t(avatarErrorKey(err)));
		} finally {
			setBusy(null);
		}
	}

	async function remove() {
		if (token === undefined || user === null || busy) return;
		setBusy("remove");
		setError(null);
		try {
			const result = await uploadUserAvatar(token, "");
			updateAccountUser({
				id: user.id,
				nick: result.user.nick,
				avatarUrl: result.user.avatarUrl,
			});
		} catch (err) {
			setError(t(avatarErrorKey(err)));
		} finally {
			setBusy(null);
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("profile.title")}
			size="sm"
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="md">
				<Group justify="center">
					{blobUrl !== null ? (
						<img
							src={blobUrl}
							alt={t("profile.avatarAlt")}
							style={{
								width: 96,
								height: 96,
								borderRadius: "50%",
								objectFit: "cover",
							}}
						/>
					) : (
						<Avatar size={96} radius="xl" color="blue">
							{loading ? "" : (user?.nick[0] ?? "?").toUpperCase()}
						</Avatar>
					)}
				</Group>

				<Text size="sm" c="dimmed" ta="center">
					{user?.nick}
				</Text>

				{error !== null && (
					<Alert color="red" title={t("profile.errorTitle")}>
						{error}
					</Alert>
				)}

				<Group justify="center">
					<FileButton
						accept="image/*"
						onChange={(file) => {
							void upload(file);
						}}
					>
						{(props) => (
							<Button
								onClick={props.onClick}
								loading={busy === "upload"}
								disabled={busy !== null}
								variant="default"
							>
								{t("profile.upload")}
							</Button>
						)}
					</FileButton>
					{user?.avatarUrl !== undefined && user.avatarUrl !== "" && (
						<Button
							color="red"
							variant="outline"
							loading={busy === "remove"}
							disabled={busy !== null}
							onClick={() => {
								void remove();
							}}
						>
							{t("profile.remove")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
