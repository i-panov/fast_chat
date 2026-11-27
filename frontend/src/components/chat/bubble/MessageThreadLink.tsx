import { Button, Text } from "@mantine/core";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

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
	const { t } = useTranslation();
	// An icon-only button without text needs a name; the count is part of it
	// because a screen reader cannot read the icon.
	const count = threadMessageCount ?? 0;
	return (
		<Button
			variant="subtle"
			color="gray"
			size="compact-xs"
			aria-label={`${t("message.thread")} (${count})`}
			style={{
				alignSelf: isOwn ? "flex-end" : "flex-start",
				marginTop: 2,
			}}
			onClick={() => onOpen(threadId)}
		>
			<MessageCircle size={14} />
			{count > 0 && (
				<Text component="span" size="xs" ml={2}>
					{count}
				</Text>
			)}
		</Button>
	);
}
