import {
	Button,
	Group,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { searchUsers } from "../../api.ts";
import type { Chat, User } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { GroupAvatarSection } from "./GroupAvatarSection.tsx";
import { GroupMembersList } from "./GroupMembersList.tsx";

interface Props {
	open: boolean;
	chat: Chat | null;
	onClose: () => void;
	onRename: (name: string) => void | Promise<void>;
	onAddMember: (userId: string) => void | Promise<void>;
	onRemoveMember: (userId: string) => void | Promise<void>;
	onDelete: () => void | Promise<void>;
	onUploadAvatar: (file: File) => void | Promise<void>;
}

export function GroupSettingsModal({
	open,
	chat,
	onClose,
	onRename,
	onAddMember,
	onRemoveMember,
	onDelete,
	onUploadAvatar,
}: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const myId = activeAccount?.user.id ?? "";
	const isOwner = chat !== null && chat.ownerId === myId;

	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<User[]>([]);
	const [confirming, setConfirming] = useState<"leave" | "delete" | null>(null);
	const [busy, setBusy] = useState(false);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);

	useEffect(() => {
		return () => clearTimeout(searchTimerRef.current);
	}, []);

	function startRename() {
		if (chat === null) return;
		setNameDraft(chat.name);
		setEditingName(true);
	}

	async function commitRename() {
		const trimmed = nameDraft.trim();
		if (trimmed.length === 0 || chat === null) {
			setEditingName(false);
			return;
		}
		setBusy(true);
		try {
			await onRename(trimmed);
		} finally {
			setBusy(false);
			setEditingName(false);
		}
	}

	function handleQueryChange(value: string) {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (value.length === 0) {
			setResults([]);
			return;
		}
		if (activeAccount === null || chat === null) return;
		searchTimerRef.current = setTimeout(() => {
			searchUsers(activeAccount.token, value)
				.then(({ users }) => {
					setResults(
						users.filter(
							(u) =>
								u.id !== activeAccount.user.id &&
								!chat.members.some((m) => m.id === u.id),
						),
					);
				})
				.catch(() => setResults([]));
		}, 300);
	}

	async function handleConfirm() {
		if (confirming === null) return;
		setBusy(true);
		try {
			if (confirming === "delete") {
				await onDelete();
			} else if (confirming === "leave") {
				await onRemoveMember(myId);
			}
		} finally {
			setBusy(false);
			setConfirming(null);
		}
	}

	if (chat === null) return null;

	const myMember = chat.members.find((m) => m.id === myId);
	const canLeave = !isOwner && myMember !== undefined;

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={t("chat.settings")}
			size="md"
			centered
		>
			<Stack gap="md">
				<GroupAvatarSection
					chat={chat}
					token={activeAccount?.token}
					isOwner={isOwner}
					onUploadAvatar={onUploadAvatar}
				/>

				{editingName ? (
					<Group gap="xs">
						<TextInput
							value={nameDraft}
							onChange={(e) => setNameDraft(e.currentTarget.value)}
							maxLength={60}
							style={{ flex: 1 }}
							autoFocus
						/>
						<Button
							onClick={() => {
								void commitRename();
							}}
							loading={busy}
							size="xs"
						>
							{t("chat.save")}
						</Button>
						<Button
							variant="default"
							onClick={() => setEditingName(false)}
							size="xs"
						>
							{t("accounts.cancel")}
						</Button>
					</Group>
				) : (
					<Group justify="space-between" align="center">
						<Text fw={600}>{chat.name}</Text>
						{isOwner && (
							<Button variant="subtle" size="xs" onClick={startRename}>
								{t("chat.rename")}
							</Button>
						)}
					</Group>
				)}

				<GroupMembersList
					members={chat.members}
					ownerId={chat.ownerId}
					myId={myId}
					isOwner={isOwner}
					onRemoveMember={(id) => {
						setConfirming(null);
						void onRemoveMember(id);
					}}
				/>

				{isOwner && (
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
									maxHeight: 140,
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
										justify="flex-start"
										style={{ borderRadius: 0 }}
										onClick={() => {
											setQuery("");
											setResults([]);
											void onAddMember(u.id);
										}}
									>
										<Text size="sm">@{u.nick}</Text>
									</Button>
								))}
							</ScrollArea>
						)}
					</div>
				)}

				<Group justify="space-between">
					{confirming === null ? (
						<>
							{canLeave && (
								<Button
									color="orange"
									variant="default"
									onClick={() => setConfirming("leave")}
								>
									{t("chat.leaveGroup")}
								</Button>
							)}
							{isOwner ? (
								<Button color="red" onClick={() => setConfirming("delete")}>
									{t("chat.deleteGroup")}
								</Button>
							) : (
								<div />
							)}
						</>
					) : (
						<Group>
							<Text size="sm" c={confirming === "delete" ? "red" : "orange"}>
								{confirming === "delete"
									? t("chat.deleteGroupConfirm")
									: t("chat.leaveGroupConfirm")}
							</Text>
							<Button
								color={confirming === "delete" ? "red" : "orange"}
								size="xs"
								loading={busy}
								onClick={() => {
									void handleConfirm();
								}}
							>
								{t("chat.save")}
							</Button>
							<Button
								variant="default"
								size="xs"
								onClick={() => setConfirming(null)}
							>
								{t("accounts.cancel")}
							</Button>
						</Group>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
