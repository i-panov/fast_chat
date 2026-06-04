import { Anchor, Group, Skeleton, Stack, Text } from "@mantine/core";
import { MapPin } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Location } from "../../api.ts";
import { formatCoords, openStreetMapURL } from "../../utils/chat.ts";

const LeafletMiniMap = lazy(() =>
	import("./LocationMiniMapLeaflet.tsx").then((m) => ({
		default: m.LocationMiniMapLeaflet,
	})),
);

interface Props {
	location: Location;
}

export function LocationMiniMap({ location }: Props) {
	const { t } = useTranslation();
	const [loaded, setLoaded] = useState(false);

	return (
		<Stack gap={4} style={{ marginTop: 4 }}>
			<div
				style={{
					position: "relative",
					height: 160,
					width: 240,
					maxWidth: "100%",
					borderRadius: 6,
					overflow: "hidden",
					cursor: "pointer",
				}}
			>
				{!loaded && (
					<Skeleton
						height={160}
						width={240}
						radius="sm"
						style={{ position: "absolute", inset: 0 }}
					/>
				)}
				<Suspense fallback={null}>
					<LeafletMiniMap location={location} onReady={() => setLoaded(true)} />
				</Suspense>
			</div>
			<Group gap={6} wrap="nowrap">
				<MapPin
					size={14}
					style={{ flexShrink: 0, color: "var(--mantine-color-gray-5)" }}
				/>
				<Text size="xs" c="dimmed">
					{formatCoords(location)}
				</Text>
				<Anchor
					href={openStreetMapURL(location)}
					target="_blank"
					rel="noreferrer"
					size="xs"
				>
					{t("message.openInMap")}
				</Anchor>
			</Group>
		</Stack>
	);
}
