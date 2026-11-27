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
	ConfirmDialog,
	type ConfirmState,
	errorKey,
	useReload,
} from "./shared.tsx";

function encryptionLabel(mode: string, t: TFunction): string {
	switch (mode) {
		case "e2ee":
			return t("admin.encryptionE2EE");
		case "server":
			return t("admin.encryptionPlaintext");
		default:
			return mode;
	}
}

const KEY_ENABLE = "admin.enable";
const KEY_DISABLE = "admin.disable";

export function BotsTab({ token, t }: { token: string; t: TFunction }) {
	const [bots, setBots] = useState<AdminBot[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [confirm, setConfirm] = useState<ConfirmState | null>(null);
	const [version, reload] = useReload();

	// biome-ignore lint/correctness/useExhaustiveDependencies: version is the manual reload trigger.
	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		void adminListBots(token)
			.then((result) => {
				if (!cancelled) setBots(result.bots);
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
			{error !== null && <Alert color="red">{error}</Alert>}
			{loading ? (
				<Loader size="sm" />
			) : error === null && bots.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("admin.empty")}
				</Text>
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
											{encryptionLabel(bot.encryptionMode, t)}
										</Badge>
									</Table.Td>
									<Table.Td>
										<Button
											size="compact-xs"
											color={bot.isActive ? "red" : "green"}
											variant="light"
											aria-label={`${bot.isActive ? t(KEY_DISABLE) : t(KEY_ENABLE)}: ${bot.username}`}
											onClick={() => {
												const next = !bot.isActive;
												setConfirm({
													title: next ? t(KEY_DISABLE) : t(KEY_ENABLE),
													body: next
														? t("admin.disableBotConfirm")
														: t("admin.enableBotConfirm"),
													confirmLabel: next ? t(KEY_DISABLE) : t(KEY_ENABLE),
													danger: next,
													onConfirm: async () => {
														setError(null);
														await adminPatchBot(token, bot.id, next);
														reload();
													},
												});
											}}
										>
											{bot.isActive ? t(KEY_DISABLE) : t(KEY_ENABLE)}
										</Button>
									</Table.Td>
								</Table.Tr>
							))}
						</Table.Tbody>
					</Table>
				</Table.ScrollContainer>
			)}
			<ConfirmDialog state={confirm} onClose={() => setConfirm(null)} t={t} />
		</Stack>
	);
}
