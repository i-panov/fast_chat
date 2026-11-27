import { Alert, Button, Loader, Stack, Table, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import {
	type AdminChat,
	adminDeleteMessage,
	adminListMessages,
} from "../../api.ts";
import type { Message } from "../../types/api.ts";
import { formatDateTime } from "../../utils/chat.ts";
import {
	COLUMN_ACTIONS,
	type ConfirmState,
	errorKey,
	useReload,
} from "./shared.tsx";

const KEY_DELETE = "admin.delete";

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
	const requestSeqRef = useRef(0);

	useEffect(() => {
		chatIdRef.current = chat?.id;
	}, [chat]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		if (chat === null) return;
		const seq = ++requestSeqRef.current;
		let cancelled = false;
		// Do not show the previous chat's rows (or its cursor) under the
		// new chat's header while the request is in flight.
		setMessages([]);
		setCursor(undefined);
		setHasMore(false);
		setLoading(true);
		setError(null);
		void adminListMessages(token, chat.id)
			.then((result) => {
				if (cancelled || seq !== requestSeqRef.current) return;
				setMessages(result.messages ?? []);
				setCursor(result.nextCursor);
				setHasMore(result.hasMore);
			})
			.catch((err: unknown) => {
				if (cancelled || seq !== requestSeqRef.current) return;
				setError(t(errorKey(err)));
			})
			.finally(() => {
				if (cancelled || seq !== requestSeqRef.current) return;
				setLoading(false);
			});

		return () => {
			cancelled = true;
		};
	}, [token, chat, version, t]);

	async function loadMore() {
		if (chat === null || cursor === undefined || loadingMore) return;
		const chatID = chat.id;
		const seq = requestSeqRef.current;
		setLoadingMore(true);
		setError(null);
		try {
			const result = await adminListMessages(token, chatID, cursor);
			// Another chat may have been selected while the page was in
			// flight; appending it would mix two chats and target the wrong
			// chat on delete.
			if (seq !== requestSeqRef.current || chatIdRef.current !== chatID) {
				return;
			}
			// Pages walk backwards from the newest message: older ones go on
			// top, not below the newer ones already shown.
			setMessages((prev) => [...(result.messages ?? []), ...prev]);
			setCursor(result.nextCursor);
			setHasMore(result.hasMore);
		} catch (err) {
			if (seq === requestSeqRef.current) setError(t(errorKey(err)));
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
										<Text size="xs">{formatDateTime(message.createdAt)}</Text>
									</Table.Td>
									<Table.Td>
										<Button
											size="compact-xs"
											color="red"
											variant="light"
											aria-label={`${t(KEY_DELETE)}: ${message.fromNick} ${formatDateTime(message.createdAt)}`}
											onClick={() => {
												ask({
													title: t("admin.deleteMessageTitle"),
													body: t("admin.deleteMessageConfirm"),
													confirmLabel: t(KEY_DELETE),
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
											{t(KEY_DELETE)}
										</Button>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
			{/* A stale cursor from the previous chat must not be usable while
			    the new chat is still loading. */}
			{hasMore && !loading && (
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
