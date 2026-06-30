import { Text } from "@mantine/core";

interface Props {
	nick: string;
}

export function MessageAuthor({ nick }: Props) {
	return (
		<Text
			size="xs"
			c="dimmed"
			style={{
				alignSelf: "flex-start",
				marginLeft: 8,
				marginBottom: 2,
			}}
		>
			@{nick}
		</Text>
	);
}
