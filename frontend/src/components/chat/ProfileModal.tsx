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
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { uploadFile, uploadUserAvatar } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
	user: { id: string; nick: string; avatarUrl?: string } | null;
}

export function ProfileModal({ open, onClose, token, user }: Props) {
	const { t } = useTranslation();
	const { updateAccountUser } = useAuth();
	const { blobUrl, loading } = useFileUrl(user?.avatarUrl, token);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function upload(file: File | null) {
		if (file === null || token === undefined || user === null) return;
		setBusy(true);
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
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	async function remove() {
		if (token === undefined || user === null) return;
		setBusy(true);
		setError(null);
		try {
			const result = await uploadUserAvatar(token, "");
			updateAccountUser({
				id: user.id,
				nick: result.user.nick,
				avatarUrl: result.user.avatarUrl,
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("profile.title")}
			size="sm"
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
							<Button {...props} loading={busy} variant="default">
								{t("profile.upload")}
							</Button>
						)}
					</FileButton>
					{user?.avatarUrl !== undefined && user.avatarUrl !== "" && (
						<Button
							color="red"
							variant="outline"
							disabled={busy}
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
