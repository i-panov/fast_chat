import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { type AdminUser, adminListUsers, adminPatchUser } from "../../api.ts";
import {
	AdminPagination,
	AdminSearchForm,
	COLUMN_ACTIONS,
	COLUMN_NAME,
	type ConfirmState,
	errorKey,
	useReload,
} from "./shared.tsx";

const KEY_GRANT_ADMIN = "admin.grantAdmin";
const KEY_REVOKE_ADMIN = "admin.revokeAdmin";
const KEY_BAN = "admin.ban";
const KEY_UNBAN = "admin.unban";

export function UsersTab({
	token,
	selfID,
	ask,
	t,
}: {
	token: string;
	selfID: string;
	ask: (state: ConfirmState) => void;
	t: TFunction;
}) {
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [users, setUsers] = useState<AdminUser[]>([]);
	const [total, setTotal] = useState(0);
	const [offset, setOffset] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [version, reload] = useReload();

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		void adminListUsers(token, submitted, offset)
			.then((page) => {
				if (cancelled) return;
				setUsers(page.users);
				setTotal(page.total);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(t(errorKey(err)));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [token, submitted, offset, version, t]);

	async function patch(
		user: AdminUser,
		patchBody: { isAdmin?: boolean; banned?: boolean },
	) {
		try {
			await adminPatchUser(token, user.id, patchBody);
			reload();
		} catch (err) {
			// A rejected role/ban change must be visible: the dialog that
			// triggered it is already closed.
			setError(t(errorKey(err)));
		}
	}

	return (
		<Stack gap="md">
			<AdminSearchForm
				value={query}
				onChange={setQuery}
				placeholder={t("admin.searchUsers")}
				onSubmit={() => {
					const next = query.trim();
					// Re-submitting the same query on the first page must
					// refresh the list instead of doing nothing.
					if (next === submitted && offset === 0) {
						reload();
					} else {
						setOffset(0);
						setSubmitted(next);
					}
				}}
				t={t}
			/>

			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : error === null && users.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("admin.empty")}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t(COLUMN_NAME)}</Table.Th>
								<Table.Th>{t("admin.email")}</Table.Th>
								<Table.Th>{t("admin.role")}</Table.Th>
								<Table.Th>{t(COLUMN_ACTIONS)}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{users.map((user) => (
								<Table.Tr key={user.id}>
									<Table.Td>
										<Text size="sm">{user.username}</Text>
										{user.displayName && user.displayName !== user.username && (
											<Text size="xs" c="dimmed">
												{user.displayName}
											</Text>
										)}
									</Table.Td>
									<Table.Td>
										<Text size="xs">{user.email}</Text>
									</Table.Td>
									<Table.Td>
										<Group gap={4}>
											{user.isAdmin && (
												<Badge size="xs" color="blue">
													{t("admin.admin")}
												</Badge>
											)}
											{user.isBot && (
												<Badge size="xs" color="grape">
													{t("admin.bot")}
												</Badge>
											)}
											{user.banned && (
												<Badge size="xs" color="red">
													{t("admin.banned")}
												</Badge>
											)}
										</Group>
									</Table.Td>
									<Table.Td>
										<Group gap={4} wrap="wrap">
											<Button
												size="compact-xs"
												variant="light"
												disabled={user.id === selfID || user.isBot}
												aria-label={`${user.isAdmin ? t(KEY_REVOKE_ADMIN) : t(KEY_GRANT_ADMIN)}: ${user.username}`}
												onClick={() => {
													const next = !user.isAdmin;
													ask({
														title: next
															? t(KEY_GRANT_ADMIN)
															: t(KEY_REVOKE_ADMIN),
														body: next
															? t("admin.grantAdminConfirm")
															: t("admin.revokeAdminConfirm"),
														confirmLabel: next
															? t(KEY_GRANT_ADMIN)
															: t(KEY_REVOKE_ADMIN),
														danger: !next,
														onConfirm: () => patch(user, { isAdmin: next }),
													});
												}}
											>
												{user.isAdmin
													? t(KEY_REVOKE_ADMIN)
													: t(KEY_GRANT_ADMIN)}
											</Button>
											<Button
												size="compact-xs"
												color="red"
												variant="light"
												disabled={user.id === selfID || user.isBot}
												aria-label={`${user.banned ? t(KEY_UNBAN) : t(KEY_BAN)}: ${user.username}`}
												onClick={() => {
													const next = !user.banned;
													ask({
														title: next ? t(KEY_BAN) : t(KEY_UNBAN),
														body: next
															? t("admin.banConfirm")
															: t("admin.unbanConfirm"),
														confirmLabel: next ? t(KEY_BAN) : t(KEY_UNBAN),
														danger: next,
														onConfirm: () => patch(user, { banned: next }),
													});
												}}
											>
												{user.banned ? t(KEY_UNBAN) : t(KEY_BAN)}
											</Button>
										</Group>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}

			<AdminPagination
				offset={offset}
				total={total}
				onChange={setOffset}
				t={t}
			/>
		</Stack>
	);
}
