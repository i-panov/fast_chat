import { ActionIcon, Button, Group, Popover } from "@mantine/core";
import { SmilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addMessageReaction, removeMessageReaction } from "../../../api.ts";
import { messagesRepo } from "../../../db/messagesRepo.ts";
import { outboxRepo } from "../../../db/outboxRepo.ts";
import { threadMessagesRepo } from "../../../db/threadMessagesRepo.ts";
import { scheduleSync } from "../../../sync/syncEngine.ts";
import type { ReactionSummary } from "../../../types/api.ts";
import { useAuth } from "../../../useAuth.tsx";

const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

interface Props {
	chatId: string;
	messageId: string;
	reactions: ReactionSummary[] | undefined;
	disabled?: boolean;
	threadId?: string;
}

export function ReactionBar({
	chatId,
	messageId,
	reactions,
	disabled,
	threadId,
}: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const [items, setItems] = useState<ReactionSummary[]>(reactions ?? []);
	const [open, setOpen] = useState(false);
	// Two fast taps on one emoji used to compute "mine" from the same snapshot
	// and enqueue two opposite ops. Ignore taps until the current one settles.
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		setItems(reactions ?? []);
	}, [reactions]);

	const blocked = disabled === true || busy;

	async function toggle(emoji: string) {
		const token = activeAccount?.token;
		if (token === undefined || blocked) return;
		setOpen(false);
		setBusy(true);

		const mine = items.find((r) => r.emoji === emoji)?.me === true;
		const optimistic = mine
			? items
					.map((reaction) =>
						reaction.emoji === emoji
							? { ...reaction, count: reaction.count - 1, me: false }
							: reaction,
					)
					.filter((reaction) => reaction.count > 0)
			: items.some((reaction) => reaction.emoji === emoji)
				? items.map((reaction) =>
						reaction.emoji === emoji
							? { ...reaction, count: reaction.count + 1, me: true }
							: reaction,
					)
				: [...items, { emoji, count: 1, me: true }];
		if (typeof navigator !== "undefined" && !navigator.onLine) {
			await outboxRepo.enqueue({
				kind: "reaction",
				opId: crypto.randomUUID(),
				chatId,
				messageId,
				emoji,
				action: mine ? "remove" : "add",
				previousReactions: items,
				threadId,
				createdAt: new Date().toISOString(),
				attempts: 0,
			});
			setItems((current) => {
				if (mine) {
					return current.flatMap((reaction) => {
						if (reaction.emoji !== emoji) return [reaction];
						const count = Math.max(0, reaction.count - 1);
						return count === 0 ? [] : [{ ...reaction, count, me: false }];
					});
				}
				const existing = current.find((reaction) => reaction.emoji === emoji);
				if (existing === undefined) {
					return [...current, { emoji, count: 1, me: true }];
				}
				return current.map((reaction) =>
					reaction.emoji === emoji
						? { ...reaction, count: reaction.count + 1, me: true }
						: reaction,
				);
			});
			if (threadId !== undefined) {
				await threadMessagesRepo.updateReactions(
					threadId,
					messageId,
					optimistic,
				);
			} else {
				await messagesRepo.updateReactions(chatId, messageId, optimistic);
			}
			scheduleSync();
			setBusy(false);
			return;
		}
		try {
			const result = mine
				? await removeMessageReaction(token, chatId, messageId, emoji)
				: await addMessageReaction(token, chatId, messageId, emoji);
			setItems(result.reactions);
		} catch {
			// The server is authoritative; the next SSE/sync will repair it.
		} finally {
			setBusy(false);
		}
	}

	return (
		<Group gap={4} mt={4} wrap="nowrap">
			{items.map((reaction) => (
				<Button
					key={reaction.emoji}
					size="compact-xs"
					variant={reaction.me === true ? "light" : "default"}
					disabled={blocked}
					onClick={() => {
						void toggle(reaction.emoji);
					}}
					aria-label={`${reaction.emoji} ${reaction.count}`}
				>
					{reaction.emoji} {reaction.count}
				</Button>
			))}
			<Popover
				opened={open}
				onChange={setOpen}
				position="top-start"
				withArrow
				shadow="md"
			>
				<Popover.Target>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						disabled={blocked}
						onClick={() => setOpen((value) => !value)}
						aria-label={t("reaction.add")}
					>
						<SmilePlus size={14} />
					</ActionIcon>
				</Popover.Target>
				<Popover.Dropdown p={4}>
					<Group gap={2} wrap="nowrap">
						{EMOJIS.map((emoji) => (
							<ActionIcon
								key={emoji}
								size="md"
								variant="subtle"
								onClick={() => {
									void toggle(emoji);
								}}
								aria-label={emoji}
							>
								{emoji}
							</ActionIcon>
						))}
					</Group>
				</Popover.Dropdown>
			</Popover>
		</Group>
	);
}
