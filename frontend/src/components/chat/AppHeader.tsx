import { ActionIcon, Group, Loader, Paper, Tooltip } from "@mantine/core";
import { Menu } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useNetworkStatus } from "../../hooks/useNetworkStatus.ts";
import { useSyncStatus } from "../../hooks/useSyncStatus.ts";

interface Props {
	onSwitcherToggle: () => void;
}

function Dot({ color, label }: { color: string; label: string }) {
	return (
		<Tooltip label={label} withArrow>
			<span
				role="img"
				aria-label={label}
				tabIndex={0}
				style={{
					width: 10,
					height: 10,
					borderRadius: "50%",
					background: color,
					display: "block",
				}}
			/>
		</Tooltip>
	);
}

export function AppHeader({ onSwitcherToggle }: Props) {
	const { t } = useTranslation();
	const isOnline = useNetworkStatus();
	const syncState = useSyncStatus();

	let indicator: ReactNode;
	if (syncState === "syncing") {
		indicator = (
			<Tooltip label={t("sync.syncing")} withArrow>
				<Loader size={14} aria-label={t("sync.syncing")} />
			</Tooltip>
		);
	} else if (!isOnline) {
		indicator = (
			<Dot color="var(--mantine-color-red-6)" label={t("sync.offline")} />
		);
	} else if (syncState === "error") {
		indicator = (
			<Dot color="var(--mantine-color-red-6)" label={t("sync.error")} />
		);
	} else {
		indicator = (
			<Dot color="var(--mantine-color-green-6)" label={t("sync.online")} />
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
