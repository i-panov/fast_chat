import { Anchor, Group, Modal, Stack, Text } from "@mantine/core";
import type L from "leaflet";
import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapContainer, Marker, TileLayer } from "react-leaflet";
import type { Location } from "../../api.ts";
import { formatCoords, openStreetMapURL } from "../../utils/chat.ts";
import "../../utils/leafletIconFix.ts";

interface Props {
	open: boolean;
	location: Location;
	editable: boolean;
	onClose: () => void;
	onChange?: (loc: Location) => void;
	onRemove?: () => void;
}

export function LocationLightbox({
	open,
	location,
	editable,
	onClose,
	onChange,
	onRemove,
}: Props) {
	const { t } = useTranslation();
	const [pos, setPos] = useState<Location>({
		lat: location.lat,
		lng: location.lng,
	});
	const markerRef = useRef<L.Marker | null>(null);

	useEffect(() => {
		if (open) {
			setPos({ lat: location.lat, lng: location.lng });
		}
	}, [open, location.lat, location.lng]);

	function handleMarkerDragEnd() {
		const m = markerRef.current;
		if (m === null) return;
		const ll = m.getLatLng();
		setPos({ lat: ll.lat, lng: ll.lng });
	}

	function handleSave() {
		onChange?.({ lat: pos.lat, lng: pos.lng });
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={
				<Group gap={6}>
					<MapPin size={18} />
					<span>{t("message.location")}</span>
				</Group>
			}
			size="lg"
			centered
		>
			<Stack gap="sm">
				<div
					style={{
						height: 400,
						borderRadius: 8,
						overflow: "hidden",
					}}
				>
					<MapContainer
						center={[pos.lat, pos.lng]}
						zoom={15}
						style={{ height: "100%", width: "100%" }}
						scrollWheelZoom
					>
						<TileLayer
							attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
							url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
						/>
						<Marker
							draggable={editable}
							position={[pos.lat, pos.lng]}
							ref={markerRef}
							eventHandlers={{ dragend: handleMarkerDragEnd }}
						/>
					</MapContainer>
				</div>
				<Group gap={6} wrap="nowrap">
					<MapPin size={14} style={{ flexShrink: 0 }} />
					<Text size="sm">{formatCoords(pos)}</Text>
				</Group>
				<Group justify="space-between">
					<Anchor
						href={openStreetMapURL(pos)}
						target="_blank"
						rel="noreferrer"
						size="sm"
					>
						{t("message.openInMap")}
					</Anchor>
					<Group gap="xs">
						{editable && onRemove !== undefined && (
							<button
								type="button"
								onClick={onRemove}
								style={{
									background: "transparent",
									border: "1px solid var(--mantine-color-red-5)",
									color: "var(--mantine-color-red-5)",
									padding: "4px 12px",
									borderRadius: 4,
									cursor: "pointer",
									fontSize: 14,
								}}
							>
								{t("input.locationClear")}
							</button>
						)}
						{editable && onChange !== undefined && (
							<button
								type="button"
								onClick={handleSave}
								style={{
									background: "var(--mantine-color-blue-6)",
									border: "none",
									color: "white",
									padding: "4px 12px",
									borderRadius: 4,
									cursor: "pointer",
									fontSize: 14,
								}}
							>
								{t("input.save")}
							</button>
						)}
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}
