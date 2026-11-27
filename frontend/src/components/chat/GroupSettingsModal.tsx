import {
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
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ApiError, searchUsers } from "../../api.ts";
import type { Chat, User } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { GroupAvatarSection } from "./GroupAvatarSection.tsx";
import { GroupMembersList } from "./GroupMembersList.tsx";

// The server limit is 60 runes, not UTF-16 units: counting code units would
// reject long Cyrillic names that the backend accepts.
const MAX_GROUP_NAME_RUNES = 60;

function runeLength(value: string): number {
	return Array.from(value).length;
}

function actionErrorKey(error: unknown): string {
	if (error instanceof ApiError && error.status === 403)
		return "error.forbidden";
	if (error instanceof ApiError && error.status === 404)
		return "error.notFound";

	return "error.requestFailed";
}

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

interface GroupNameSectionProps {
	name: string;
	editing: boolean;
	draft: string;
	busy: boolean;
	isOwner: boolean;
	onDraftChange: (value: string) => void;
	onCommit: () => void;
	onCancel: () => void;
	onStartRename: () => void;
}

function GroupNameSection({
	name,
	editing,
	draft,
	busy,
	isOwner,
	onDraftChange,
	onCommit,
	onCancel,
	onStartRename,
}: GroupNameSectionProps) {
	const { t } = useTranslation();

	if (!editing) {
		return (
			<Group justify="space-between" align="center">
				<Text fw={600}>{name}</Text>
				{isOwner && (
					<Button variant="subtle" size="xs" onClick={onStartRename}>
						{t("chat.rename")}
					</Button>
				)}
			</Group>
		);
	}

	return (
		<Group gap="xs">
			<TextInput
				value={draft}
				onChange={(e) => onDraftChange(e.currentTarget.value)}
				aria-label={t("chat.groupName")}
				style={{ flex: 1 }}
				autoFocus
			/>
			<Button onClick={onCommit} loading={busy} size="xs">
				{t("chat.save")}
			</Button>
			<Button variant="default" onClick={onCancel} size="xs">
				{t("accounts.cancel")}
			</Button>
		</Group>
	);
}

interface AddMemberSectionProps {
	query: string;
	results: User[];
	onQueryChange: (value: string) => void;
	onAddMember: (userId: string) => void;
}

function AddMemberSection({
	query,
	results,
	onQueryChange,
	onAddMember,
}: AddMemberSectionProps) {
	const { t } = useTranslation();

	return (
		<div>
			<Text size="sm" fw={500} mb={4}>
				{t("chat.addMember")}
			</Text>
			<TextInput
				placeholder={t("search.placeholder")}
				aria-label={t("search.placeholder")}
				value={query}
				onChange={(e) => onQueryChange(e.currentTarget.value)}
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
							onClick={() => onAddMember(u.id)}
						>
							<Text size="sm">@{u.nick}</Text>
						</Button>
					))}
				</ScrollArea>
			)}
		</div>
	);
}

interface DangerActionsSectionProps {
	confirming: "leave" | "delete" | null;
	chatName: string;
	canLeave: boolean;
	isOwner: boolean;
	busy: boolean;
	onRequestLeave: () => void;
	onRequestDelete: () => void;
	onConfirm: () => void;
	onCancel: () => void;
}

function DangerActionsSection({
	confirming,
	chatName,
	canLeave,
	isOwner,
	busy,
	onRequestLeave,
	onRequestDelete,
	onConfirm,
	onCancel,
}: DangerActionsSectionProps) {
	const { t } = useTranslation();

	if (confirming !== null) {
		const isDelete = confirming === "delete";
		return (
			<Group>
				<Text size="sm" c={isDelete ? "red" : "orange"}>
					{isDelete
						? t("chat.deleteGroupConfirmName", { name: chatName })
						: t("chat.leaveGroupConfirmName", { name: chatName })}
				</Text>
				<Button
					color={isDelete ? "red" : "orange"}
					size="xs"
					loading={busy}
					onClick={onConfirm}
				>
					{isDelete ? t("chat.deleteGroup") : t("chat.leaveGroup")}
				</Button>
				<Button variant="default" size="xs" onClick={onCancel}>
					{t("accounts.cancel")}
				</Button>
			</Group>
		);
	}

	return (
		<>
			{canLeave && (
				<Button color="orange" variant="default" onClick={onRequestLeave}>
					{t("chat.leaveGroup")}
				</Button>
			)}
			{isOwner ? (
				<Button color="red" onClick={onRequestDelete}>
					{t("chat.deleteGroup")}
				</Button>
			) : (
				<div />
			)}
		</>
	);
}

interface MemberSearchParams {
	open: boolean;
	chat: Chat | null;
	token: string | undefined;
	myId: string;
}

// Debounced, sequence-guarded user lookup that always filters against the
// freshest chat and account (a late response must not add an existing member
// or a bot after the dialog switched groups).
function useMemberSearch({ open, chat, token, myId }: MemberSearchParams) {
	const [query, setQuery] = useState("");
	const [results, setResults] = useState<User[]>([]);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
		undefined,
	);
	const searchSeqRef = useRef(0);
	const chatRef = useRef(chat);
	const tokenRef = useRef(token);
	const myIdRef = useRef(myId);
	useEffect(() => {
		chatRef.current = chat;
		tokenRef.current = token;
		myIdRef.current = myId;
	});

	useEffect(() => {
		return () => clearTimeout(searchTimerRef.current);
	}, []);

	const chatId = chat?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset effect intentionally keyed by chat/open switch.
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setResults([]);
		searchSeqRef.current++;
		clearTimeout(searchTimerRef.current);
	}, [chatId, open]);

	function clear() {
		setQuery("");
		setResults([]);
		searchSeqRef.current++;
		clearTimeout(searchTimerRef.current);
	}

	function handleQueryChange(value: string) {
		setQuery(value);
		clearTimeout(searchTimerRef.current);
		if (value.length === 0) {
			setResults([]);
			return;
		}
		const freshChat = chatRef.current;
		if (tokenRef.current === undefined || freshChat === null) return;
		const seq = ++searchSeqRef.current;
		const tokenForSearch = tokenRef.current;
		searchTimerRef.current = setTimeout(() => {
			searchUsers(tokenForSearch, value)
				.then(({ users }) => {
					if (searchSeqRef.current !== seq) return;
					const latestChat = chatRef.current;
					if (latestChat === null) return;
					setResults(
						users.filter(
							(u) =>
								u.id !== myIdRef.current &&
								// Bots are 1-1 only: the server rejects them as
								// group members.
								u.isBot !== true &&
								!latestChat.members.some((m) => m.id === u.id),
						),
					);
				})
				.catch(() => {
					if (searchSeqRef.current === seq) setResults([]);
				});
		}, 300);
	}

	return { query, results, handleQueryChange, clear };
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
	const fullScreen = useMediaQuery("(max-width: 48em)") === true;
	const myId = activeAccount?.user.id ?? "";
	const isOwner = chat !== null && chat.ownerId === myId;

	const [editingName, setEditingName] = useState(false);
	const [nameDraft, setNameDraft] = useState("");
	const [confirming, setConfirming] = useState<"leave" | "delete" | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const {
		query,
		results,
		handleQueryChange,
		clear: clearSearch,
	} = useMemberSearch({
		open,
		chat,
		token: activeAccount?.token,
		myId,
	});

	const chatId = chat?.id;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset effect intentionally keyed by chat/open switch.
	useEffect(() => {
		if (!open) return;
		setEditingName(false);
		setNameDraft("");
		setConfirming(null);
		setBusy(false);
		setError(null);
	}, [chatId, open]);

	async function runAction(action: () => void | Promise<void>) {
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(t(actionErrorKey(err)));
		}
	}

	function startRename() {
		if (chat === null) return;
		setNameDraft(chat.name);
		setError(null);
		setEditingName(true);
	}

	async function commitRename() {
		const trimmed = nameDraft.trim();
		if (trimmed.length === 0 || chat === null) {
			setEditingName(false);
			return;
		}
		if (runeLength(trimmed) > MAX_GROUP_NAME_RUNES) {
			setError(t("chat.groupNameTooLong", { max: MAX_GROUP_NAME_RUNES }));
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await onRename(trimmed);
			setEditingName(false);
		} catch (err) {
			setError(t(actionErrorKey(err)));
		} finally {
			setBusy(false);
		}
	}

	async function handleConfirm() {
		if (confirming === null) return;
		setBusy(true);
		setError(null);
		try {
			if (confirming === "delete") {
				await onDelete();
			} else if (confirming === "leave") {
				await onRemoveMember(myId);
			}
			setConfirming(null);
		} catch (err) {
			// Keep the confirmation open so the user can retry.
			setError(t(actionErrorKey(err)));
		} finally {
			setBusy(false);
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
			fullScreen={fullScreen}
			centered
		>
			<Stack gap="md">
				{error !== null && <Alert color="red">{error}</Alert>}
				<GroupAvatarSection
					chat={chat}
					token={activeAccount?.token}
					isOwner={isOwner}
					onUploadAvatar={onUploadAvatar}
				/>

				<GroupNameSection
					name={chat.name}
					editing={editingName}
					draft={nameDraft}
					busy={busy}
					isOwner={isOwner}
					onDraftChange={setNameDraft}
					onCommit={() => {
						void commitRename();
					}}
					onCancel={() => setEditingName(false)}
					onStartRename={startRename}
				/>

				<GroupMembersList
					members={chat.members}
					ownerId={chat.ownerId}
					myId={myId}
					isOwner={isOwner}
					onRemoveMember={(id) => {
						setConfirming(null);
						void runAction(() => onRemoveMember(id));
					}}
				/>

				{isOwner && (
					<AddMemberSection
						query={query}
						results={results}
						onQueryChange={handleQueryChange}
						onAddMember={(id) => {
							clearSearch();
							void runAction(() => onAddMember(id));
						}}
					/>
				)}

				<Group justify="space-between">
					<DangerActionsSection
						confirming={confirming}
						chatName={chat.name}
						canLeave={canLeave}
						isOwner={isOwner}
						busy={busy}
						onRequestLeave={() => setConfirming("leave")}
						onRequestDelete={() => setConfirming("delete")}
						onConfirm={() => {
							void handleConfirm();
						}}
						onCancel={() => setConfirming(null)}
					/>
				</Group>
			</Stack>
		</Modal>
	);
}
