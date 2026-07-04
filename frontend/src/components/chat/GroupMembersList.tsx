import { ActionIcon, Group, ScrollArea, Stack, Text } from "@mantine/core";
import { Crown, X } from "lucide-react";
import { useTranslation } from "react-i18next";

interface Props {
	members: Array<{ id: string; nick: string }>;
	ownerId: string;
	myId: string;
	isOwner: boolean;
	onRemoveMember: (userId: string) => void;
}

export function GroupMembersList({
	members,
	ownerId,
	myId,
	isOwner,
	onRemoveMember,
}: Props) {
	const { t } = useTranslation();

	return (
		<div>
			<Text size="sm" fw={500} mb={4}>
				{t("chat.members")} ({members.length})
			</Text>
			<ScrollArea
				style={{
					maxHeight: 200,
					border: "1px solid var(--mantine-color-dark-4)",
					borderRadius: 4,
				}}
			>
				<Stack gap={0}>
					{members.map((m) => {
						const isMe = m.id === myId;
						const isThisOwner = m.id === ownerId;
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
										<Crown size={14} color="var(--mantine-color-yellow-5)" />
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
										onClick={() => onRemoveMember(m.id)}
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
	);
}
