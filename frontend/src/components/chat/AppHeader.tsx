import { ActionIcon, Group, Paper } from "@mantine/core";
import { Menu } from "lucide-react";

interface Props {
	onSwitcherToggle: () => void;
}

export function AppHeader({ onSwitcherToggle }: Props) {
	return (
		<Paper
			component="header"
			style={{
				borderRadius: 0,
				background: "var(--mantine-color-dark-6)",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
			}}
		>
			<Group px="md" h={48}>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="lg"
					onClick={onSwitcherToggle}
				>
					<Menu size={18} />
				</ActionIcon>
			</Group>
		</Paper>
	);
}
