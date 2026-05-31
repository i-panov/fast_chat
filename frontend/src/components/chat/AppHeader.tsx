import { ActionIcon, Badge, Button, Group, Paper, Text } from "@mantine/core";

interface Props {
	nick: string;
	accountCount: number;
	onSwitcherToggle: () => void;
	onLogout: () => void;
}

export function AppHeader({
	nick,
	accountCount,
	onSwitcherToggle,
	onLogout,
}: Props) {
	return (
		<Paper
			component="header"
			style={{
				borderRadius: 0,
				background: "var(--mantine-color-dark-6)",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
		>
			<Group justify="space-between" px="md" h={48}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="lg"
					onClick={onSwitcherToggle}
				>
					☰
				</ActionIcon>
				<Text fw={600} size="sm">
					@{nick}
					{accountCount > 1 && (
						<Badge size="xs" variant="filled" ml={4} color="gray">
							+{accountCount - 1}
						</Badge>
					)}
				</Text>
				<Button variant="outline" size="compact-sm" onClick={onLogout}>
					Logout
				</Button>
			</Group>
		</Paper>
	);
}
