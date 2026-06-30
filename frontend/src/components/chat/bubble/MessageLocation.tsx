import { UnstyledButton } from "@mantine/core";
import type { Location } from "../../../api.ts";
import { LocationMiniMap } from "../LocationMiniMap.tsx";

interface Props {
	location: Location;
	onOpen: () => void;
}

export function MessageLocation({ location, onOpen }: Props) {
	return (
		<UnstyledButton
			onClick={onOpen}
			style={{
				display: "block",
				padding: 0,
				marginTop: 4,
				maxWidth: "100%",
			}}
		>
			<LocationMiniMap location={location} />
		</UnstyledButton>
	);
}
