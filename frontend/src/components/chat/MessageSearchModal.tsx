import {
	Button,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useLocalMessageSearch } from "../../hooks/useLocalMessageSearch.ts";

interface Props {
	open: boolean;
	onClose: () => void;
	userId: string;
	onSelect: (chatId: string, messageId: string) => void;
}

export function MessageSearchModal({ open, onClose, userId, onSelect }: Props) {
	const { t } = useTranslation();
	const { query, setQuery, results, loading } = useLocalMessageSearch(
		open ? userId : undefined,
	);

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("messageSearch.title")}
			size="md"
			centered
		>
			<Stack gap="sm">
				<TextInput
					leftSection={<Search size={16} />}
					placeholder={t("messageSearch.placeholder")}
					value={query}
					onChange={(event) => setQuery(event.currentTarget.value)}
					autoFocus
				/>
				{loading ? (
					<Group justify="center">
						<Loader size="sm" />
					</Group>
				) : results.length === 0 ? (
					<Text size="sm" c="dimmed">
						{query.trim().length < 2
							? t("messageSearch.hint")
							: t("messageSearch.empty")}
					</Text>
				) : (
					<ScrollArea.Autosize mah={420}>
						<Stack gap="xs">
							{results.map((result) => (
								<Button
									key={`${result.chatId}:${result.message.id}`}
									variant="subtle"
									color="gray"
									fullWidth
									justify="flex-start"
									onClick={() => {
										onSelect(result.chatId, result.message.id);
										onClose();
									}}
								>
									<div style={{ minWidth: 0, textAlign: "left" }}>
										<Text size="xs" c="dimmed">
											{result.chatTitle} · @{result.message.fromNick}
										</Text>
										<Text size="sm" truncate="end">
											{result.message.text}
										</Text>
									</div>
								</Button>
							))}
						</Stack>
					</ScrollArea.Autosize>
				)}
			</Stack>
		</Modal>
	);
}
