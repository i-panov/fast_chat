import {
	Anchor,
	Group,
	Skeleton,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { MapPin } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Location } from "../../types/api.ts";
import { formatCoords, openStreetMapURL } from "../../utils/chat.ts";
import { ErrorBoundary } from "../ErrorBoundary.tsx";

const LeafletMiniMap = lazy(() =>
	import("./LocationMiniMapLeaflet.tsx").then((m) => ({
		default: m.LocationMiniMapLeaflet,
	})),
);

interface Props {
	location: Location;
}

function MiniMapBody({ location }: Props) {
	const { t } = useTranslation();
	const [loaded, setLoaded] = useState(false);
	// The tiles of OpenStreetMap are requested only after the user asks for
	// the map: a message of an E2EE location must not reveal its coordinates
	// (and the reader's IP) to a third party just by scrolling past.
	const [showMap, setShowMap] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset effect intentionally re-runs when the location changes.
	useEffect(() => {
		setLoaded(false);
		setShowMap(false);
	}, [location.lat, location.lng]);

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
				{!showMap && (
					<UnstyledButton
						onClick={() => setShowMap(true)}
						aria-label={t("message.location")}
						style={{
							position: "absolute",
							inset: 0,
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							background: "var(--mantine-color-dark-6)",
						}}
					>
						<Stack align="center" gap={4}>
							<MapPin size={22} />
							<Text size="xs" c="dimmed">
								{t("message.location")}
							</Text>
						</Stack>
					</UnstyledButton>
				)}
				{showMap && (
					<>
						{!loaded && (
							<Skeleton
								height={160}
								width={240}
								radius="sm"
								style={{ position: "absolute", inset: 0 }}
							/>
						)}
						<Suspense fallback={null}>
							<LeafletMiniMap
								location={location}
								onReady={() => setLoaded(true)}
							/>
						</Suspense>
					</>
				)}
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
					rel="noopener noreferrer"
					size="xs"
					onClick={(e) => e.stopPropagation()}
				>
					{t("message.openInMap")}
				</Anchor>
			</Group>
		</Stack>
	);
}

export function LocationMiniMap({ location }: Props) {
	const { t } = useTranslation();
	return (
		<ErrorBoundary
			fallback={
				<Text size="xs" c="dimmed">
					{formatCoords(location)} —{" "}
					<Anchor
						href={openStreetMapURL(location)}
						target="_blank"
						rel="noopener noreferrer"
						size="xs"
						onClick={(e) => e.stopPropagation()}
					>
						{t("message.openInMap")}
					</Anchor>
				</Text>
			}
		>
			<MiniMapBody location={location} />
		</ErrorBoundary>
	);
}
