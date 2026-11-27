import {
	Alert,
	Button,
	Group,
	Loader,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { type AdminAuditEntry, adminListAudit } from "../../api.ts";
import { formatDateTime } from "../../utils/chat.ts";
import { errorKey, useReload } from "./shared.tsx";

// Audit rows store machine codes; show a translated label when the code is
// known and the raw value otherwise (so new backend actions stay visible).
const ACTION_KEYS: Record<string, string> = {
	"user.admin": "admin.actionUserAdmin",
	"user.ban": "admin.actionUserBan",
	"chat.delete": "admin.actionChatDelete",
	"message.delete": "admin.actionMessageDelete",
	"bot.active": "admin.actionBotActive",
};

function actionLabel(action: string, t: TFunction): string {
	const key = ACTION_KEYS[action];

	return key === undefined ? action : t(key);
}

export function AuditTab({ token, t }: { token: string; t: TFunction }) {
	const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [version, reload] = useReload();

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		void adminListAudit(token)
			.then((result) => {
				if (!cancelled) setEntries(result.entries);
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
	}, [token, version, t]);

	return (
		<Stack gap="md">
			<Group justify="flex-end">
				<Button size="xs" variant="default" loading={loading} onClick={reload}>
					{t("admin.refresh")}
				</Button>
			</Group>
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : error === null && entries.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("admin.empty")}
				</Text>
			) : (
				<Table.ScrollContainer minWidth={640}>
					<Table striped>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t("admin.when")}</Table.Th>
								<Table.Th>{t("admin.actor")}</Table.Th>
								<Table.Th>{t("admin.action")}</Table.Th>
								<Table.Th>{t("admin.target")}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{entries.map((entry) => (
								<Table.Tr key={entry.id}>
									<Table.Td>
										<Text size="xs">{formatDateTime(entry.createdAt)}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{entry.actorId}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{actionLabel(entry.action, t)}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">
											{entry.targetType}:{entry.targetId}
											{entry.detail ? ` (${entry.detail})` : ""}
										</Text>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
		</Stack>
	);
}
