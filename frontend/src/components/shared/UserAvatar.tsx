import { Avatar } from "@mantine/core";
import { useFileUrl } from "../../hooks/useFileUrl.ts";

interface Props {
	nick: string;
	avatarUrl: string | undefined;
	token: string | undefined;
	size?: number;
}

export function UserAvatar({ nick, avatarUrl, token, size = 28 }: Props) {
	const { blobUrl } = useFileUrl(avatarUrl, token);

	if (avatarUrl !== undefined && avatarUrl !== "" && blobUrl !== null) {
		return (
			<img
				src={blobUrl}
				alt=""
				style={{
					width: size,
					height: size,
					borderRadius: "50%",
					objectFit: "cover",
					flexShrink: 0,
				}}
			/>
		);
	}

	return (
		<Avatar size={size} radius="xl" color="blue">
			{(nick[0] ?? "?").toUpperCase()}
		</Avatar>
	);
}
