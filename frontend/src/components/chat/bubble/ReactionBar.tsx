import { ActionIcon, Button, Group, Popover } from "@mantine/core";
import { SmilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { addMessageReaction, removeMessageReaction } from "../../../api.ts";
import type { ReactionSummary } from "../../../types/api.ts";
import { useAuth } from "../../../useAuth.tsx";

const EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🎉"];

interface Props {
	chatId: string;
	messageId: string;
	reactions: ReactionSummary[] | undefined;
	disabled?: boolean;
}

export function ReactionBar({ chatId, messageId, reactions, disabled }: Props) {
	const { t } = useTranslation();
	const { activeAccount } = useAuth();
	const [items, setItems] = useState<ReactionSummary[]>(reactions ?? []);
	const [open, setOpen] = useState(false);

	useEffect(() => {
		setItems(reactions ?? []);
	}, [reactions]);

	async function toggle(emoji: string) {
		const token = activeAccount?.token;
		if (token === undefined || disabled === true) return;
		setOpen(false);

		const mine = items.find((r) => r.emoji === emoji)?.me === true;
		try {
			const result = mine
				? await removeMessageReaction(token, chatId, messageId, emoji)
				: await addMessageReaction(token, chatId, messageId, emoji);
			setItems(result.reactions);
		} catch {
			// The server is authoritative; the next SSE/sync will repair it.
		}
	}

	return (
		<Group gap={4} mt={4} wrap="nowrap">
			{items.map((reaction) => (
				<Button
					key={reaction.emoji}
					size="compact-xs"
					variant={reaction.me === true ? "light" : "default"}
					disabled={disabled}
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
						disabled={disabled}
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
