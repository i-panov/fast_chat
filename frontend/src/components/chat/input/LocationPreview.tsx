import { ActionIcon, Paper, Text } from "@mantine/core";
import { MapPin, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Location } from "../../../types/api.ts";
import { formatCoords } from "../../../utils/chat.ts";

const LOCATION_PREVIEW_MAX_WIDTH = 240;

export function LocationPreview({
	location,
	onRemove,
	dimmed,
}: {
	location: Location;
	onRemove: () => void;
	dimmed: boolean;
}) {
	const { t } = useTranslation();
	return (
		<Paper
			style={{
				padding: "6px 10px",
				display: "flex",
				alignItems: "center",
				gap: 8,
				background: "var(--mantine-color-dark-6)",
				borderRadius: 6,
				maxWidth: LOCATION_PREVIEW_MAX_WIDTH,
				opacity: dimmed ? 0.85 : 1,
			}}
		>
			<MapPin
				size={20}
				style={{ flexShrink: 0, color: "var(--mantine-color-blue-5)" }}
			/>
			<div style={{ overflow: "hidden", minWidth: 0 }}>
				<Text size="xs" truncate="end">
					{formatCoords(location)}
				</Text>
			</div>
			<ActionIcon
				variant="subtle"
				color="gray"
				size="sm"
				onClick={onRemove}
				style={{ flexShrink: 0 }}
				aria-label={t("media.removeLocation")}
			>
				<X size={14} />
			</ActionIcon>
		</Paper>
	);
}
