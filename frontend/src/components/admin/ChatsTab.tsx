import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Stack,
	Table,
	Text,
	TextInput,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { type AdminChat, adminDeleteChat, adminListChats } from "../../api.ts";
import {
	COLUMN_ACTIONS,
	COLUMN_NAME,
	type ConfirmState,
	errorText,
	PAGE_SIZE,
	useReload,
} from "./shared.tsx";

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
		void adminListChats(token, submitted, offset)
			.then((page) => {
				if (cancelled) return;
				setChats(page.chats);
				setTotal(page.total);
			})
			.catch((err: unknown) => {
				if (!cancelled) setError(errorText(err));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [token, submitted, offset, version]);

	return (
		<Stack gap="md">
			<form
				onSubmit={(event) => {
					event.preventDefault();
					setOffset(0);
					setSubmitted(query.trim());
				}}
			>
				<Group>
					<TextInput
						placeholder={t("admin.searchChats")}
						value={query}
						onChange={(event) => setQuery(event.currentTarget.value)}
						style={{ flex: 1 }}
					/>
					<Button type="submit">{t("admin.search")}</Button>
				</Group>
			</form>

			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : chats.length === 0 ? (
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
											{chat.type}
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
												onClick={() => onMessages(chat)}
											>
												{t("admin.messages")}
											</Button>
											<Button
												size="compact-xs"
												color="red"
												variant="light"
												onClick={() => {
													ask({
														title: t("admin.deleteChatTitle"),
														body: t("admin.deleteChatConfirm", {
															chat: chat.name || chat.id,
														}),
														onConfirm: async () => {
															await adminDeleteChat(token, chat.id);
															reload();
														},
													});
												}}
											>
												{t("admin.delete")}
											</Button>
										</Group>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}

			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					{t("admin.total", { count: total })}
				</Text>
				<Group gap="xs">
					<Button
						size="xs"
						variant="default"
						disabled={offset === 0}
						onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
					>
						{t("admin.prev")}
					</Button>
					<Button
						size="xs"
						variant="default"
						disabled={offset + PAGE_SIZE >= total}
						onClick={() => setOffset(offset + PAGE_SIZE)}
					>
						{t("admin.next")}
					</Button>
				</Group>
			</Group>
		</Stack>
	);
}
