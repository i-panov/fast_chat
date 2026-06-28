import { useCallback, useState } from "react";
import type { Chat } from "../api.ts";
import {
	addChatMember,
	createChat,
	deleteChat,
	getChatInfo,
	removeChatMember,
	updateChat,
	uploadChatAvatar,
	uploadFile,
} from "../api.ts";
import { chatsRepo } from "../db/chatsRepo.ts";
import { scheduleSync } from "../sync/syncEngine.ts";

export interface UseGroupSettingsParams {
	token: string | undefined;
	userId: string | undefined;
	activeChatId: string | null;
	selectChat: (chatId: string | null) => void;
}

export interface UseGroupSettingsReturn {
	createGroupOpen: boolean;
	setCreateGroupOpen: (v: boolean) => void;
	handleCreateGroup: (name: string, memberIds: string[]) => Promise<void>;

	groupSettingsChatId: string | null;
	groupSettings: Chat | null;
	openGroupSettings: (chatId: string) => Promise<void>;
	closeGroupSettings: () => void;

	handleRenameGroup: (name: string) => Promise<void>;
	handleAddGroupMember: (userId: string) => Promise<void>;
	handleRemoveGroupMember: (userId: string) => Promise<void>;
	handleDeleteGroup: () => Promise<void>;
	handleUploadGroupAvatar: (file: File) => Promise<void>;
}

export function useGroupSettings({
	token,
	userId,
	activeChatId,
	selectChat,
}: UseGroupSettingsParams): UseGroupSettingsReturn {
	const [createGroupOpen, setCreateGroupOpen] = useState(false);
	const [groupSettingsChatId, setGroupSettingsChatId] = useState<string | null>(
		null,
	);
	const [groupSettings, setGroupSettings] = useState<Chat | null>(null);

	const handleCreateGroup = useCallback(
		async (name: string, memberIds: string[]) => {
			if (!token) return;
			const { chat } = await createChat(token, {
				type: "group",
				name,
				memberIds,
			});
			await chatsRepo.upsert(chat);
			setCreateGroupOpen(false);
			selectChat(chat.id);
		},
		[token, selectChat],
	);

	const openGroupSettings = useCallback(
		async (chatId: string) => {
			if (!token) return;
			setGroupSettingsChatId(chatId);
			try {
				const { chat } = await getChatInfo(token, chatId);
				setGroupSettings(chat);
				await chatsRepo.upsert(chat);
			} catch {
				setGroupSettingsChatId(null);
			}
		},
		[token],
	);

	const closeGroupSettings = useCallback(() => {
		setGroupSettingsChatId(null);
		setGroupSettings(null);
	}, []);

	const handleRenameGroup = useCallback(
		async (name: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await updateChat(token, groupSettingsChatId, { name });
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleAddGroupMember = useCallback(
		async (userIdToAdd: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await addChatMember(
				token,
				groupSettingsChatId,
				userIdToAdd,
			);
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleRemoveGroupMember = useCallback(
		async (userIdToRemove: string) => {
			if (!token || !groupSettingsChatId) return;
			const { chat } = await removeChatMember(
				token,
				groupSettingsChatId,
				userIdToRemove,
			);
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
			if (userIdToRemove === userId) {
				closeGroupSettings();
				if (activeChatId === groupSettingsChatId) {
					selectChat(null);
				}
			}
		},
		[
			token,
			groupSettingsChatId,
			userId,
			closeGroupSettings,
			activeChatId,
			selectChat,
		],
	);

	const handleDeleteGroup = useCallback(async () => {
		if (!token || !groupSettingsChatId) return;
		await deleteChat(token, groupSettingsChatId);
		scheduleSync();
		if (activeChatId === groupSettingsChatId) {
			selectChat(null);
		}
		closeGroupSettings();
	}, [
		token,
		groupSettingsChatId,
		activeChatId,
		selectChat,
		closeGroupSettings,
	]);

	const handleUploadGroupAvatar = useCallback(
		async (file: File) => {
			if (!token || !groupSettingsChatId) return;
			const { file: uploaded } = await uploadFile(token, file);
			const { chat } = await uploadChatAvatar(
				token,
				groupSettingsChatId,
				uploaded.id,
			);
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
		},
		[token, groupSettingsChatId],
	);

	return {
		createGroupOpen,
		setCreateGroupOpen,
		handleCreateGroup,
		groupSettingsChatId,
		groupSettings,
		openGroupSettings,
		closeGroupSettings,
		handleRenameGroup,
		handleAddGroupMember,
		handleRemoveGroupMember,
		handleDeleteGroup,
		handleUploadGroupAvatar,
	};
}
