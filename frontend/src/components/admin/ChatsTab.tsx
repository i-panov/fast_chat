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
import { type AdminChat, adminDeleteChat, adminListChats } from "../../api.ts";
import {
	AdminPagination,
	AdminSearchForm,
	COLUMN_ACTIONS,
	COLUMN_NAME,
	type ConfirmState,
	errorKey,
	useReload,
} from "./shared.tsx";

const KEY_DELETE = "admin.delete";

function chatTypeLabel(type: string, t: TFunction): string {
	switch (type) {
		case "group":
			return t("admin.typeGroup");
		case "private":
			return t("admin.typePrivate");
		case "self":
			return t("admin.typeSelf");
		default:
			return type;
	}
}

export function ChatsTab({
	token,
	ask,
	onMessages,
	t,
}: {
	token: string;
	ask: (state: ConfirmState) => void;
	onMessages: (chat: AdminChat) => void;
	t: TFunction;
}) {
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [chats, setChats] = useState<AdminChat[]>([]);
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
		setChats([]);
		void adminListChats(token, submitted, offset)
			.then((page) => {
				if (cancelled) return;
				setChats(page.chats);
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

	return (
		<Stack gap="md">
			<AdminSearchForm
				value={query}
				onChange={setQuery}
				placeholder={t("admin.searchChats")}
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
			) : error === null && chats.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("admin.empty")}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table striped highlightOnHover>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t(COLUMN_NAME)}</Table.Th>
								<Table.Th>{t("admin.type")}</Table.Th>
								<Table.Th>{t("admin.owner")}</Table.Th>
								<Table.Th>{t(COLUMN_ACTIONS)}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{chats.map((chat) => (
								<Table.Tr key={chat.id}>
									<Table.Td>
										<Text size="sm">{chat.name || chat.id}</Text>
										<Text size="xs" c="dimmed">
											{chat.id}
										</Text>
									</Table.Td>
									<Table.Td>
										<Badge size="xs" variant="light">
											{chatTypeLabel(chat.type, t)}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{chat.ownerId || "—"}</Text>
									</Table.Td>
									<Table.Td>
										<Group gap={4}>
											<Button
												size="compact-xs"
												variant="light"
												aria-label={`${t("admin.messages")}: ${chat.name || chat.id}`}
												onClick={() => onMessages(chat)}
											>
												{t("admin.messages")}
											</Button>
											<Button
												size="compact-xs"
												color="red"
												variant="light"
												aria-label={`${t(KEY_DELETE)}: ${chat.name || chat.id}`}
												onClick={() => {
													ask({
														title: t("admin.deleteChatTitle"),
														body: t("admin.deleteChatConfirm", {
															chat: chat.name || chat.id,
														}),
														confirmLabel: t(KEY_DELETE),
														onConfirm: async () => {
															await adminDeleteChat(token, chat.id);
															reload();
														},
													});
												}}
											>
												{t(KEY_DELETE)}
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
