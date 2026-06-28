import { ActionIcon, Group, Loader, Paper, Text, Tooltip } from "@mantine/core";
import { CloudOff, Loader2, Menu, RefreshCw, Wifi } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { outboxRepo } from "../../db/outboxRepo.ts";
import { useLiveQuery } from "../../db/useLiveQuery.ts";
import { useNetworkStatus } from "../../hooks/useNetworkStatus.ts";
import { useSyncStatus } from "../../hooks/useSyncStatus.ts";
import { runSync } from "../../sync/syncEngine.ts";

interface Props {
	onSwitcherToggle: () => void;
}

export function AppHeader({ onSwitcherToggle }: Props) {
	const { t } = useTranslation();
	const isOnline = useNetworkStatus();
	const syncState = useSyncStatus();
	const query = useCallback(() => outboxRepo.count(), []);
	const pending = useLiveQuery<number>(query) ?? 0;

	let indicator: React.ReactNode = null;
	if (!isOnline) {
		indicator = (
			<Tooltip label={t("sync.offline")} withArrow>
				<Group gap={4} align="center">
					<CloudOff size={16} aria-label={t("sync.offline")} />
					{pending > 0 && (
						<Text size="xs" c="dimmed">
							{t("sync.pending", { count: pending })}
						</Text>
					)}
				</Group>
			</Tooltip>
		);
	} else if (syncState === "syncing") {
		indicator = (
			<Tooltip label={t("sync.syncing")} withArrow>
				<Loader size={14} aria-label={t("sync.syncing")} />
			</Tooltip>
		);
	} else if (syncState === "error") {
		indicator = (
			<Tooltip label={t("sync.error")} withArrow>
				<ActionIcon
					variant="subtle"
					color="red"
					size="sm"
					onClick={() => void runSync()}
					aria-label={t("sync.error")}
				>
					<RefreshCw size={16} />
				</ActionIcon>
			</Tooltip>
		);
	} else if (pending > 0) {
		indicator = (
			<Tooltip label={t("sync.pending", { count: pending })} withArrow>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => void runSync()}
					aria-label={t("sync.pending", { count: pending })}
				>
					<Loader2 size={16} />
				</ActionIcon>
			</Tooltip>
		);
	} else {
		indicator = (
			<Tooltip label={t("sync.syncing")} withArrow>
				<Wifi size={16} aria-label={t("sync.syncing")} />
			</Tooltip>
		);
	}

	return (
		<Paper
			component="header"
			style={{
				borderRadius: 0,
				background: "var(--mantine-color-dark-6)",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
		>
			<Group px="md" h={48} justify="space-between">
				<ActionIcon
					variant="subtle"
					color="gray"
					size="lg"
					onClick={onSwitcherToggle}
					aria-label={t("accounts.title")}
				>
					<Menu size={18} />
				</ActionIcon>
				{indicator}
			</Group>
		</Paper>
	);
}
