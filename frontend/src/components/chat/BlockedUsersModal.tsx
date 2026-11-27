import {
	Alert,
	Button,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
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

function blockedName(user: BlockedUser): string {
	// A federated user may have no local profile: the id ("nick:domain") is
	// the only thing the server can return.
	return user.nick !== "" ? user.nick : user.id;
}

export function BlockedUsersModal({ open, onClose, token }: Props) {
	const { t } = useTranslation();
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const [users, setUsers] = useState<BlockedUser[]>([]);
	const [loading, setLoading] = useState(false);
	const [loaded, setLoaded] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open || token === undefined) return;
		let cancelled = false;
		setLoading(true);
		setLoaded(false);
		setError(null);
		void getBlockedUsers(token)
			.then((result) => {
				if (cancelled) return;
				setUsers(result.users);
				setLoaded(true);
			})
			.catch(() => {
				if (!cancelled) setError(t("blocks.loadError"));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, token, t]);

	async function unblock(id: string) {
		if (token === undefined) return;
		setBusy(id);
		setError(null);
		try {
			const result = await unblockUser(token, id);
			setUsers(result.users);
			setLoaded(true);
		} catch {
			setError(t("blocks.unblockError"));
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
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="sm">
				{error !== null && <Alert color="red">{error}</Alert>}
				{loading ? (
					<Group justify="center">
						<Loader size="sm" />
					</Group>
				) : loaded && users.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("blocks.empty")}
					</Text>
				) : (
					users.map((user) => {
						const name = blockedName(user);

						return (
							<Group key={user.id} justify="space-between" wrap="nowrap">
								<Group gap="xs" wrap="nowrap">
									<UserAvatar
										nick={name}
										avatarUrl={user.avatarUrl}
										token={token}
										size={28}
									/>
									<Text size="sm">@{name}</Text>
								</Group>
								<Button
									size="compact-xs"
									variant="outline"
									loading={busy === user.id}
									aria-label={`${t("blocks.unblock")}: ${name}`}
									onClick={() => {
										void unblock(user.id);
									}}
								>
									{t("blocks.unblock")}
								</Button>
							</Group>
						);
					})
				)}
			</Stack>
		</Modal>
	);
}
