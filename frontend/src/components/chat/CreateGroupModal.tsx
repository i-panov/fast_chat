import {
	ActionIcon,
	Button,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchUsers } from "../../api.ts";
import type { User } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";

interface Props {
	open: boolean;
	onClose: () => void;
	onCreate: (name: string, memberIds: string[]) => void | Promise<void>;
}

export function CreateGroupModal({ open, onClose, onCreate }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<User[]>([]);
	const [picked, setPicked] = useState<User[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	useEffect(() => {
		return () => clearTimeout(searchTimerRef.current);
	}, []);

	function handleQueryChange(value: string) {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (value.length === 0) {
			setResults([]);
			return;
		}
		if (activeAccount === null) return;
		searchTimerRef.current = setTimeout(() => {
			searchUsers(activeAccount.token, value)
				.then(({ users }) => {
					setResults(
						users.filter(
							(u) =>
								u.id !== activeAccount.user.id &&
								!picked.some((p) => p.id === u.id),
						),
					);
				})
				.catch(() => {
					setResults([]);
				});
		}, 300);
	}

	function pick(user: User) {
		setPicked((prev) => [...prev, user]);
		setResults((prev) => prev.filter((r) => r.id !== user.id));
		setQuery("");
	}

	function unpick(id: string) {
		setPicked((prev) => prev.filter((p) => p.id !== id));
	}

	async function handleCreate() {
		if (name.trim().length === 0 || submitting) return;
		setSubmitting(true);
		try {
			await onCreate(
				name.trim(),
				picked.map((p) => p.id),
			);
			setName("");
			setPicked([]);
			setQuery("");
			setResults([]);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("chat.createGroup")}
			size="md"
			centered
		>
			<Stack gap="md">
				<TextInput
					label={t("chat.groupName")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					maxLength={60}
					required
				/>
				<Text size="xs" c="dimmed">
					{t("chat.createGroupHint")}
				</Text>
				<div>
					<Text size="sm" fw={500} mb={4}>
						{t("chat.addMember")}
					</Text>
					<TextInput
						placeholder={t("search.placeholder")}
						value={query}
						onChange={(e) => handleQueryChange(e.currentTarget.value)}
					/>
					{results.length > 0 && (
						<ScrollArea
							style={{
								maxHeight: 160,
								border: "1px solid var(--mantine-color-dark-4)",
								borderRadius: 4,
								marginTop: 4,
							}}
						>
							{results.map((u) => (
								<Button
									key={u.id}
									variant="subtle"
									color="gray"
									fullWidth
									justify="space-between"
									style={{ borderRadius: 0 }}
									onClick={() => pick(u)}
								>
									<Text size="sm">@{u.nick}</Text>
									<Plus size={14} />
								</Button>
							))}
						</ScrollArea>
					)}
				</div>
				{picked.length > 0 && (
					<div>
						<Text size="sm" fw={500} mb={4}>
							{t("chat.members")} ({picked.length})
						</Text>
						<Stack gap={4}>
							{picked.map((u) => (
								<Group
									key={u.id}
									justify="space-between"
									style={{
										padding: "4px 8px",
										background: "var(--mantine-color-dark-6)",
										borderRadius: 4,
									}}
								>
									<Text size="sm">@{u.nick}</Text>
									<ActionIcon
										variant="transparent"
										color="gray"
										size="sm"
										onClick={() => unpick(u.id)}
									>
										<X size={14} />
									</ActionIcon>
								</Group>
							))}
						</Stack>
					</div>
				)}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("accounts.cancel")}
					</Button>
					<Button
						onClick={handleCreate}
						disabled={name.trim().length === 0}
						loading={submitting}
					>
						{t("chat.createGroup")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
