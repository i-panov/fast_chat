import { Button, Text } from "@mantine/core";
import { MessageCircle } from "lucide-react";

interface Props {
	threadId: string;
	threadMessageCount?: number;
	isOwn: boolean;
	onOpen: (threadId: string) => void;
}

export function MessageThreadLink({
	threadId,
	threadMessageCount,
	isOwn,
	onOpen,
}: Props) {
	return (
		<Button
			variant="subtle"
			color="gray"
			size="compact-xs"
			style={{
				alignSelf: isOwn ? "flex-end" : "flex-start",
				marginTop: 2,
			}}
			onClick={() => onOpen(threadId)}
		>
			<MessageCircle size={14} />
			{threadMessageCount !== undefined && threadMessageCount > 0 && (
				<Text component="span" size="xs" ml={2}>
					{threadMessageCount}
				</Text>
			)}
		</Button>
	);
}
