import { Alert, Loader, Stack, Table, Text } from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { type AdminAuditEntry, adminListAudit } from "../../api.ts";
import { errorText } from "./shared.tsx";

export function AuditTab({ token, t }: { token: string; t: TFunction }) {
	const [entries, setEntries] = useState<AdminAuditEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void adminListAudit(token)
			.then((result) => {
				if (!cancelled) setEntries(result.entries);
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
	}, [token]);

	return (
		<Stack gap="md">
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : entries.length === 0 ? (
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
										<Text size="xs">
											{new Date(entry.createdAt).toLocaleString()}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{entry.actorId}</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{entry.action}</Text>
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
