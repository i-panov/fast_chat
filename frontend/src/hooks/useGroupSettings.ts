import { useCallback, useRef, useState } from "react";
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
import type { Chat } from "../types/api.ts";

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
	// Every open bumps the sequence: a slow getChatInfo for group A must not
	// overwrite group B, otherwise the mutations (which target the displayed
	// chat id) could rename or delete the wrong group.
	const openSeqRef = useRef(0);

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
			const seq = ++openSeqRef.current;
			setGroupSettingsChatId(chatId);
			// Show the new group's skeleton, not the previous group's data.
			setGroupSettings(null);
			try {
				const { chat } = await getChatInfo(token, chatId);
				if (openSeqRef.current !== seq) return;
				setGroupSettings(chat);
				await chatsRepo.upsert(chat);
			} catch {
				if (openSeqRef.current !== seq) return;
				setGroupSettingsChatId(null);
				// Drop the previous chat's settings so a failed open never
				// shows stale data for another group.
				setGroupSettings(null);
			}
		},
		[token],
	);

	const closeGroupSettings = useCallback(() => {
		// Invalidate in-flight open/mutation responses.
		openSeqRef.current++;
		setGroupSettingsChatId(null);
		setGroupSettings(null);
	}, []);

	const handleRenameGroup = useCallback(
		async (name: string) => {
			if (!token || !groupSettingsChatId) return;
			const seq = openSeqRef.current;
			const { chat } = await updateChat(token, groupSettingsChatId, { name });
			if (openSeqRef.current !== seq) return;
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleAddGroupMember = useCallback(
		async (userIdToAdd: string) => {
			if (!token || !groupSettingsChatId) return;
			const seq = openSeqRef.current;
			const { chat } = await addChatMember(
				token,
				groupSettingsChatId,
				userIdToAdd,
			);
			if (openSeqRef.current !== seq) return;
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
		},
		[token, groupSettingsChatId],
	);

	const handleRemoveGroupMember = useCallback(
		async (userIdToRemove: string) => {
			if (!token || !groupSettingsChatId) return;
			const seq = openSeqRef.current;
			const { chat } = await removeChatMember(
				token,
				groupSettingsChatId,
				userIdToRemove,
			);
			if (openSeqRef.current !== seq) return;
			if (userIdToRemove === userId) {
				// The server view no longer contains the current user. Writing
				// it back would resurrect a group the user just left (for
				// example after an SSE chat_deleted), so drop it locally and
				// let sync clean the rest.
				await chatsRepo.remove(groupSettingsChatId);
				scheduleSync();
				if (openSeqRef.current !== seq) return;
				closeGroupSettings();
				if (activeChatId === groupSettingsChatId) {
					selectChat(null);
				}
				return;
			}
			setGroupSettings(chat);
			await chatsRepo.upsert(chat);
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
		const seq = openSeqRef.current;
		await deleteChat(token, groupSettingsChatId);
		scheduleSync();
		if (openSeqRef.current !== seq) return;
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
			const seq = openSeqRef.current;
			const { file: uploaded } = await uploadFile(token, file);
			const { chat } = await uploadChatAvatar(
				token,
				groupSettingsChatId,
				uploaded.id,
			);
			if (openSeqRef.current !== seq) return;
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
