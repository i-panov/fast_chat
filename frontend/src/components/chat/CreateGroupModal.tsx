import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, searchUsers } from "../../api.ts";
import type { User } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";

// Mirrors the server limit in runes, not UTF-16 units.
const MAX_GROUP_NAME_RUNES = 60;

function runeLength(value: string): number {
	return Array.from(value).length;
}

interface Props {
	open: boolean;
	onClose: () => void;
	onCreate: (name: string, memberIds: string[]) => void | Promise<void>;
}

function PickedMembers({
	picked,
	onUnpick,
}: {
	picked: User[];
	onUnpick: (id: string) => void;
}) {
	const { t } = useTranslation();

	if (picked.length === 0) return null;

	return (
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
							onClick={() => onUnpick(u.id)}
							aria-label={t("chat.deselectUser")}
						>
							<X size={14} />
						</ActionIcon>
					</Group>
				))}
			</Stack>
		</div>
	);
}

export function CreateGroupModal({ open, onClose, onCreate }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const [name, setName] = useState("");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<User[]>([]);
	const [picked, setPicked] = useState<User[]>([]);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const searchSeqRef = useRef(0);
	const pickedRef = useRef(picked);
	const accountRef = useRef(activeAccount);
	useEffect(() => {
		pickedRef.current = picked;
		accountRef.current = activeAccount;
	});

	useEffect(() => {
		return () => clearTimeout(searchTimerRef.current);
	}, []);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setResults([]);
		setName("");
		setPicked([]);
		setSubmitting(false);
		setError(null);
		searchSeqRef.current++;
		clearTimeout(searchTimerRef.current);
	}, [open]);

	function handleQueryChange(value: string) {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (value.length === 0) {
			setResults([]);
			return;
		}
		if (activeAccount === null) return;
		const seq = ++searchSeqRef.current;
		const token = activeAccount.token;
		const q = value;
		searchTimerRef.current = setTimeout(() => {
			searchUsers(token, q)
				.then(({ users }) => {
					if (searchSeqRef.current !== seq) return;
					const freshAccount = accountRef.current;
					if (freshAccount === null) return;
					const freshPicked = pickedRef.current;
					setResults(
						users.filter(
							(u) =>
								u.id !== freshAccount.user.id &&
								// Bots are 1-1 only: the server rejects them as
								// group members.
								u.isBot !== true &&
								!freshPicked.some((p) => p.id === u.id),
						),
					);
				})
				.catch(() => {
					if (searchSeqRef.current === seq) setResults([]);
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
		if (submitting) return;
		const trimmed = name.trim();
		if (trimmed.length === 0) return;
		if (runeLength(trimmed) > MAX_GROUP_NAME_RUNES) {
			setError(t("chat.groupNameTooLong", { max: MAX_GROUP_NAME_RUNES }));
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onCreate(
				trimmed,
				picked.map((p) => p.id),
			);
			setName("");
			setPicked([]);
			setQuery("");
			setResults([]);
		} catch (err) {
			setError(
				t(
					err instanceof ApiError && err.status === 403
						? "error.forbidden"
						: "error.requestFailed",
				),
			);
		} finally {
			setSubmitting(false);
		}
	}

	const nameTooLong = runeLength(name.trim()) > MAX_GROUP_NAME_RUNES;

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("chat.createGroup")}
			size="md"
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="md">
				{error !== null && <Alert color="red">{error}</Alert>}
				<TextInput
					label={t("chat.groupName")}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					error={
						nameTooLong
							? t("chat.groupNameTooLong", { max: MAX_GROUP_NAME_RUNES })
							: undefined
					}
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
						aria-label={t("search.placeholder")}
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
				<PickedMembers picked={picked} onUnpick={unpick} />
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("accounts.cancel")}
					</Button>
					<Button
						onClick={() => {
							void handleCreate();
						}}
						disabled={name.trim().length === 0 || nameTooLong}
						loading={submitting}
					>
						{t("chat.createGroup")}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
