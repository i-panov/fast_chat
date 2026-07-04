import { useCallback, useEffect, useRef, useState } from "react";
import { searchUsers } from "../api.ts";
import type { User } from "../types/api.ts";

export interface UseMessageSearchReturn {
	searchQuery: string;
	searchResults: User[];
	showSearchResults: boolean;
	handleSearchChange: (value: string) => void;

	pendingChatWith: string | null;
	pendingChatNick: string | null;
	selectPendingChat: (withUserId: string, withUserNick: string) => void;
	clearPendingChat: () => void;
}

export function useMessageSearch(
	token: string | undefined,
): UseMessageSearchReturn {
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<User[]>([]);
	const [showSearchResults, setShowSearchResults] = useState(false);
	const [pendingChatWith, setPendingChatWith] = useState<string | null>(null);
	const [pendingChatNick, setPendingChatNick] = useState<string | null>(null);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);

			if (!value.trim()) {
				setSearchResults([]);
				setShowSearchResults(false);
				return;
			}

			if (searchTimerRef.current) {
				clearTimeout(searchTimerRef.current);
			}

			searchTimerRef.current = setTimeout(async () => {
				if (!token) return;
				try {
					const { users } = await searchUsers(token, value);
					setSearchResults(users);
					setShowSearchResults(true);
				} catch {
					setShowSearchResults(false);
				}
			}, 300);
		},
		[token],
	);

	useEffect(() => {
		return () => {
			if (searchTimerRef.current) {
				clearTimeout(searchTimerRef.current);
			}
		};
	}, []);

	const selectPendingChat = useCallback(
		(withUserId: string, withUserNick: string) => {
			setPendingChatWith(withUserId);
			setPendingChatNick(withUserNick);
		},
		[],
	);

	const clearPendingChat = useCallback(() => {
		setPendingChatWith(null);
		setPendingChatNick(null);
	}, []);

	return {
		searchQuery,
		searchResults,
		showSearchResults,
		handleSearchChange,
		pendingChatWith,
		pendingChatNick,
		selectPendingChat,
		clearPendingChat,
	};
}
