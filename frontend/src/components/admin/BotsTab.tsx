import {
	Alert,
	Badge,
	Button,
	Loader,
	Stack,
	Table,
	Text,
} from "@mantine/core";
import type { TFunction } from "i18next";
import { useEffect, useState } from "react";
import { type AdminBot, adminListBots, adminPatchBot } from "../../api.ts";
import {
	COLUMN_ACTIONS,
	COLUMN_NAME,
	errorText,
	useReload,
} from "./shared.tsx";

export function BotsTab({ token, t }: { token: string; t: TFunction }) {
	const [bots, setBots] = useState<AdminBot[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [version, reload] = useReload();

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		void adminListBots(token)
			.then((result) => {
				if (!cancelled) setBots(result.bots);
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
	}, [token, version]);

	return (
		<Stack gap="md">
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : (
				<Table.ScrollContainer minWidth={560}>
					<Table striped>
						<Table.Thead>
							<Table.Tr>
								<Table.Th>{t(COLUMN_NAME)}</Table.Th>
								<Table.Th>{t("admin.owner")}</Table.Th>
								<Table.Th>{t("admin.encryption")}</Table.Th>
								<Table.Th>{t(COLUMN_ACTIONS)}</Table.Th>
							</Table.Tr>
						</Table.Thead>
						<Table.Tbody>
							{bots.map((bot) => (
								<Table.Tr key={bot.id}>
									<Table.Td>
										<Text size="sm">{bot.username}</Text>
										<Text size="xs" c="dimmed">
											{bot.id}
										</Text>
									</Table.Td>
									<Table.Td>
										<Text size="xs">{bot.ownerUsername}</Text>
									</Table.Td>
									<Table.Td>
										<Badge size="xs" variant="light">
											{bot.encryptionMode}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Button
											size="compact-xs"
											color={bot.isActive ? "red" : "green"}
											variant="light"
											onClick={() => {
												void adminPatchBot(token, bot.id, !bot.isActive)
													.then(reload)
													.catch((err: unknown) => setError(errorText(err)));
											}}
										>
											{bot.isActive ? t("admin.disable") : t("admin.enable")}
										</Button>
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
