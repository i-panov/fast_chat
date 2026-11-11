import { Button, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getBlockedUsers, unblockUser } from "../../api.ts";
import type { BlockedUser } from "../../types/api.ts";
import { UserAvatar } from "../shared/UserAvatar.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
	token: string | undefined;
}

export function BlockedUsersModal({ open, onClose, token }: Props) {
	const { t } = useTranslation();
	const [users, setUsers] = useState<BlockedUser[]>([]);
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);

	useEffect(() => {
		if (!open || token === undefined) return;
		let cancelled = false;
		setLoading(true);
		void getBlockedUsers(token)
			.then((result) => {
				if (!cancelled) setUsers(result.users);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token]);

	async function unblock(id: string) {
		if (token === undefined) return;
		setBusy(id);
		try {
			const result = await unblockUser(token, id);
			setUsers(result.users);
		} finally {
			setBusy(null);
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("blocks.title")}
			size="sm"
			centered
		>
			<Stack gap="sm">
				{loading ? (
					<Group justify="center">
						<Loader size="sm" />
					</Group>
				) : users.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("blocks.empty")}
					</Text>
				) : (
					users.map((user) => (
						<Group key={user.id} justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap">
								<UserAvatar
									nick={user.nick}
									avatarUrl={user.avatarUrl}
									token={token}
									size={28}
								/>
								<Text size="sm">@{user.nick}</Text>
							</Group>
							<Button
								size="compact-xs"
								variant="outline"
								loading={busy === user.id}
								onClick={() => {
									void unblock(user.id);
								}}
							>
								{t("blocks.unblock")}
							</Button>
						</Group>
					))
				)}
			</Stack>
		</Modal>
	);
}
