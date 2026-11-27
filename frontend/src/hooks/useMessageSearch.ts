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
	pendingChatIsBot: boolean;
	selectPendingChat: (
		withUserId: string,
		withUserNick: string,
		isBot?: boolean,
	) => void;
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
	const [pendingChatIsBot, setPendingChatIsBot] = useState(false);
	const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const searchSeqRef = useRef(0);

	const handleSearchChange = useCallback(
		(value: string) => {
			setSearchQuery(value);

			if (!value.trim()) {
				// Bump the sequence so a request already in flight cannot
				// reopen the dropdown with stale results after clearing.
				searchSeqRef.current += 1;
				if (searchTimerRef.current) {
					clearTimeout(searchTimerRef.current);
					searchTimerRef.current = null;
				}
				setSearchResults([]);
				setShowSearchResults(false);
				return;
			}

			if (searchTimerRef.current) {
				clearTimeout(searchTimerRef.current);
			}

			const seq = ++searchSeqRef.current;
			const debouncedSearch = async () => {
				if (!token) return;
				try {
					const { users } = await searchUsers(token, value);
					// Drop stale responses: a slow "a" must not overwrite "ab".
					if (searchSeqRef.current !== seq) return;
					setSearchResults(users);
					setShowSearchResults(true);
				} catch {
					if (searchSeqRef.current !== seq) return;
					setShowSearchResults(false);
				}
			};

			searchTimerRef.current = setTimeout(() => {
				void debouncedSearch();
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

	// Results and a pending private chat belong to the account that searched:
	// a token/account change must not leave another user's list on screen.
	// biome-ignore lint/correctness/useExhaustiveDependencies: token is the reset trigger, not a value read here
	useEffect(() => {
		searchSeqRef.current += 1;
		setSearchQuery("");
		setSearchResults([]);
		setShowSearchResults(false);
		setPendingChatWith(null);
		setPendingChatNick(null);
		setPendingChatIsBot(false);
	}, [token]);

	const selectPendingChat = useCallback(
		(withUserId: string, withUserNick: string, isBot = false) => {
			setPendingChatWith(withUserId);
			setPendingChatNick(withUserNick);
			setPendingChatIsBot(isBot);
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
		pendingChatIsBot,
		selectPendingChat,
		clearPendingChat,
	};
}
