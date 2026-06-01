import { ActionIcon, Button, Paper, Text, TextInput } from "@mantine/core";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { User } from "../../api.ts";

interface Props {
	query: string;
	results: User[];
	showResults: boolean;
	onQueryChange: (value: string) => void;
	onSelectUser: (userId: string, nick: string) => void;
}

export function SearchBox({
	query,
	results,
	showResults,
	onQueryChange,
	onSelectUser,
}: Props) {
	const { t } = useTranslation();

	return (
		<div
			style={{
				padding: "12px",
				borderBottom: "1px solid var(--mantine-color-dark-4)",
				position: "relative",
			}}
		>
			<TextInput
				placeholder={t("search.placeholder")}
				value={query}
				onChange={(e) => onQueryChange(e.target.value)}
				size="sm"
				rightSection={
					query.length > 0 ? (
						<ActionIcon
							variant="transparent"
							color="gray"
							size="sm"
							onClick={() => onQueryChange("")}
						>
							<X size={14} />
						</ActionIcon>
					) : undefined
				}
			/>
			{showResults && (
				<Paper
					style={{
						position: "absolute",
						top: "100%",
						left: 0,
						right: 0,
						zIndex: 10,
						maxHeight: "200px",
						overflowY: "auto",
						background: "var(--mantine-color-dark-8)",
					}}
					withBorder
				>
					{results.length === 0 ? (
						<Text size="sm" c="dimmed" p="sm">
							{t("search.noResults")}
						</Text>
					) : (
						results.map((u) => (
							<Button
								key={u.id}
								variant="subtle"
								color="gray"
								fullWidth
								justify="flex-start"
								style={{ borderRadius: 0 }}
								onClick={() => onSelectUser(u.id, u.nick)}
							>
								<Text size="sm">@{u.nick}</Text>
								{u.online && (
									<Text size="xs" c="dimmed" ml={4}>
										{t("search.online")}
									</Text>
								)}
							</Button>
						))
					)}
				</Paper>
			)}
		</div>
	);
}
