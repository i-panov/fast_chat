import { Alert, Button, Loader, Stack, Table, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import {
	type AdminChat,
	adminDeleteMessage,
	adminListMessages,
} from "../../api.ts";
import type { Message } from "../../types/api.ts";
import {
	COLUMN_ACTIONS,
	type ConfirmState,
	errorText,
	useReload,
} from "./shared.tsx";

export function MessagesTab({
	token,
	chat,
	ask,
	t,
}: {
	token: string;
	chat: AdminChat | null;
	ask: (state: ConfirmState) => void;
	t: TFunction;
}) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [cursor, setCursor] = useState<string | undefined>(undefined);
	const [hasMore, setHasMore] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [version, reload] = useReload();
	const chatIdRef = useRef(chat?.id);

	useEffect(() => {
		chatIdRef.current = chat?.id;
	}, [chat]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		if (chat === null) return;
		let cancelled = false;
		setLoading(true);
		setError(null);
		void adminListMessages(token, chat.id)
			.then((result) => {
				if (cancelled) return;
				setMessages(result.messages ?? []);
				setCursor(result.nextCursor);
				setHasMore(result.hasMore);
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
	}, [token, chat, version]);

	async function loadMore() {
		if (chat === null || cursor === undefined || loadingMore) return;
		const chatID = chat.id;
		setLoadingMore(true);
		setError(null);
		try {
			const result = await adminListMessages(token, chatID, cursor);
			// Another chat may have been selected while the page was in
			// flight; appending it would mix two chats and target the wrong
			// chat on delete.
			if (chatIdRef.current !== chatID) return;
			// Pages walk backwards from the newest message: older ones go on
			// top, not below the newer ones already shown.
			setMessages((prev) => [...(result.messages ?? []), ...prev]);
			setCursor(result.nextCursor);
			setHasMore(result.hasMore);
		} catch (err) {
			setError(errorText(err));
		} finally {
			setLoadingMore(false);
		}
	}

	if (chat === null) {
		return (
			<Text size="sm" c="dimmed">
				{t("admin.selectChat")}
			</Text>
		);
	}

	return (
		<Stack gap="md">
			<Text size="sm" fw={500}>
				{t("admin.messagesFor", { chat: chat.name || chat.id })}
			</Text>
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table striped>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("admin.author")}</Table.Th>
								<Table.Th>{t("admin.message")}</Table.Th>
								<Table.Th>{t("admin.when")}</Table.Th>
								<Table.Th>{t(COLUMN_ACTIONS)}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{messages.map((message) => (
								<Table.Tr key={message.id}>
									<Table.Td>
										<Text size="xs">{message.fromNick}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="sm" lineClamp={3}>
											{message.encrypted ? t("admin.encrypted") : message.text}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">
											{new Date(message.createdAt).toLocaleString()}
										</Text>
									</Table.Td>
									<Table.Td>
										<Button
											size="compact-xs"
											color="red"
											variant="light"
											onClick={() => {
												ask({
													title: t("admin.deleteMessageTitle"),
													body: t("admin.deleteMessageConfirm"),
													onConfirm: async () => {
														await adminDeleteMessage(
															token,
															chat.id,
															message.id,
														);
														reload();
													},
												});
											}}
										>
											{t("admin.delete")}
										</Button>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
			{hasMore && (
				<Button
					variant="default"
					loading={loadingMore}
					onClick={() => {
						void loadMore();
					}}
				>
					{t("admin.loadMore")}
				</Button>
			)}
		</Stack>
	);
}
