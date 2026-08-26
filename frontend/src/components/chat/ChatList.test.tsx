import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { type ReactElement, useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatsRepo } from "../../db/chatsRepo.ts";
import { resetAllDBs, setActiveAccountKey } from "../../db/init.ts";
import { useChatList } from "../../hooks/useChatList.ts";
import type { Chat } from "../../types/api.ts";
import { ChatList } from "./ChatList.tsx";

function renderChatList(ui: ReactElement) {
	return render(<MantineProvider>{ui}</MantineProvider>);
}

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string) =>
			(({ "chat.noChats": "Нет чатов" }) as Record<string, string>)[key] ?? key,
	}),
}));

vi.mock("../../i18n.ts", () => ({
	default: {
		t: (key: string) =>
			(
				({
					"chat.favorites": "Избранное",
					"chat.noChats": "Нет чатов",
				}) as Record<string, string>
			)[key] ?? key,
	},
	getCurrentLocale: () => "ru",
}));

vi.mock("../../useAuth.tsx", () => ({
	useAuth: () => ({
		activeAccount: {
			token: "test-token",
			user: { id: "alice:test", nick: "alice" },
		},
	}),
}));

const NOW = "2026-08-26T10:00:00.000Z";

function selfChat(userId: string, nick: string): Chat {
	return {
		id: `self-${userId}`,
		type: "self",
		name: "",
		ownerId: userId,
		members: [{ id: userId, nick }],
		createdAt: NOW,
	};
}

function privateChat(
	id: string,
	a: { id: string; nick: string },
	b: { id: string; nick: string },
): Chat {
	return {
		id,
		type: "private",
		name: "",
		ownerId: a.id,
		members: [a, b],
		createdAt: NOW,
	};
}

function ChatListHarness({ accountKey }: { accountKey: string }) {
	useEffect(() => {
		setActiveAccountKey(accountKey);
	}, [accountKey]);

	const { chats } = useChatList({ token: undefined });

	return (
		<ChatList
			chats={chats}
			activeChatId={null}
			userId={accountKey}
			onSelectChat={() => {}}
		/>
	);
}

beforeEach(async () => {
	setActiveAccountKey(null);
	await resetAllDBs();
});

describe("ChatList: exactly one Favorites chat", () => {
	it("shows only the active account's single Favorites chat", async () => {
		// Seed alice's account: self chat + a private chat with bob.
		setActiveAccountKey("alice:test");
		await chatsRepo.upsertMany([
			selfChat("alice:test", "alice"),
			privateChat(
				"alice-bob",
				{ id: "alice:test", nick: "alice" },
				{ id: "bob:test", nick: "bob" },
			),
		]);

		// Seed bob's account: only his self chat.
		setActiveAccountKey("bob:test");
		await chatsRepo.upsertMany([selfChat("bob:test", "bob")]);

		const { rerender } = renderChatList(
			<ChatListHarness accountKey="bob:test" />,
		);

		// Exactly one Favorites chat for bob.
		const favorites = await screen.findAllByText("Избранное");
		expect(favorites).toHaveLength(1);

		// Alice's private chat must not leak into bob's list.
		expect(screen.queryByText("alice")).toBeNull();

		// Switch to alice: exactly one Favorites chat, hers.
		rerender(
			<MantineProvider>
				<ChatListHarness accountKey="alice:test" />
			</MantineProvider>,
		);

		const aliceFavorites = await screen.findAllByText("Избранное");
		expect(aliceFavorites).toHaveLength(1);
		expect(await screen.findByText("@bob")).toBeInTheDocument();

		// Bob's self chat must not leak into alice's list.
		expect(screen.queryByText("@alice")).toBeNull();
	});

	it("shows the empty state when the active account has no chats", async () => {
		setActiveAccountKey("carol:test");

		renderChatList(<ChatListHarness accountKey="carol:test" />);

		expect(await screen.findByText("Нет чатов")).toBeInTheDocument();
		expect(screen.queryByText("Избранное")).toBeNull();
	});
});
