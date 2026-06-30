import {
	ActionIcon,
	Avatar,
	Button,
	FileButton,
	Group,
	Image,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { Crown, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Chat, User } from "../../api.ts";
import { searchUsers } from "../../api.ts";
import { useFileUrl } from "../../hooks/useFileUrl.ts";
import { useAuth } from "../../useAuth.tsx";

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

	const avatarBlobUrlResult = useFileUrl(chat?.avatarUrl, activeAccount?.token);

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
				<Group gap="md" align="center">
					{chat.avatarUrl !== undefined &&
					chat.avatarUrl !== "" &&
					avatarBlobUrlResult.blobUrl ? (
						<Image
							src={avatarBlobUrlResult.blobUrl}
							alt={t("chat.avatarAlt")}
							w={64}
							h={64}
							radius="xl"
							fit="cover"
						/>
					) : chat.avatarUrl !== undefined &&
						chat.avatarUrl !== "" &&
						avatarBlobUrlResult.loading ? (
						<Loader size="lg" />
					) : (
						<Avatar size={64} radius="xl" color="blue">
							{chat.name.charAt(0).toUpperCase() || "#"}
						</Avatar>
					)}
					{isOwner && (
						<FileButton
							onChange={(file) => {
								if (file !== null) {
									onUploadAvatar(file);
								}
							}}
							accept="image/png,image/jpeg,image/gif,image/webp"
						>
							{(props) => (
								<Button {...props} variant="default" size="xs">
									{t("chat.uploadAvatar")}
								</Button>
							)}
						</FileButton>
					)}
				</Group>

				{editingName ? (
					<Group gap="xs">
						<TextInput
							value={nameDraft}
							onChange={(e) => setNameDraft(e.currentTarget.value)}
							maxLength={60}
							style={{ flex: 1 }}
							autoFocus
						/>
						<Button onClick={commitRename} loading={busy} size="xs">
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

				<div>
					<Text size="sm" fw={500} mb={4}>
						{t("chat.members")} ({chat.members.length})
					</Text>
					<ScrollArea
						style={{
							maxHeight: 200,
							border: "1px solid var(--mantine-color-dark-4)",
							borderRadius: 4,
						}}
					>
						<Stack gap={0}>
							{chat.members.map((m) => {
								const isMe = m.id === myId;
								const isThisOwner = m.id === chat.ownerId;
								return (
									<Group
										key={m.id}
										justify="space-between"
										style={{
											padding: "6px 8px",
											borderBottom: "1px solid var(--mantine-color-dark-4)",
										}}
									>
										<Group gap={6}>
											{isThisOwner && (
												<Crown
													size={14}
													color="var(--mantine-color-yellow-5)"
												/>
											)}
											<Text size="sm">
												@{m.nick}
												{isMe && (
													<Text component="span" size="xs" c="dimmed" ml={4}>
														({t("chat.you")})
													</Text>
												)}
											</Text>
										</Group>
										{isOwner && !isThisOwner && (
											<ActionIcon
												variant="subtle"
												color="red"
												size="sm"
												onClick={() => {
													setConfirming(null);
													onRemoveMember(m.id);
												}}
											>
												<X size={14} />
											</ActionIcon>
										)}
									</Group>
								);
							})}
						</Stack>
					</ScrollArea>
				</div>

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
											onAddMember(u.id);
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
								onClick={handleConfirm}
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
