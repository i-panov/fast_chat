import type { Location } from "../../../types/api.ts";
import { LocationMiniMap } from "../LocationMiniMap.tsx";

interface Props {
	location: Location;
	onOpen: () => void;
}

export function MessageLocation({ location, onOpen }: Props) {
	// A native <button> cannot wrap the mini-map card: it contains the
	// "open in map" link, and interactive content must not nest. The div
	// stays keyboard-operable via tabIndex + Enter/Space.
	return (
		// biome-ignore lint/a11y/useSemanticElements: see above why this cannot be a <button>.
		<div
			onClick={onOpen}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					onOpen();
				}
			}}
			role="button"
			tabIndex={0}
			style={{
				display: "block",
				padding: 0,
				marginTop: 4,
				maxWidth: "100%",
				cursor: "pointer",
			}}
		>
			<LocationMiniMap location={location} />
		</div>
	);
}
