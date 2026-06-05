import { Button, Group, Modal, NumberInput, Stack, Text } from "@mantine/core";
import { Crosshair, Loader, MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MapContainer, Marker, TileLayer, useMap } from "react-leaflet";
import type { Location } from "../../api.ts";
import { formatCoords } from "../../utils/chat.ts";
import "../../utils/leafletIconFix.ts";

interface Props {
	open: boolean;
	initial: Location | null;
	onClose: () => void;
	onConfirm: (loc: Location) => void;
}

function MapRecenter({ center }: { center: [number, number] }) {
	const map = useMap();
	const lat = center[0];
	const lng = center[1];
	useEffect(() => {
		map.setView([lat, lng], map.getZoom());
	}, [lat, lng, map]);
	return null;
}

const DEFAULT_CENTER: [number, number] = [52.52, 13.405]; // Berlin
const DEFAULT_ZOOM = 13;

export function LocationPickerModal({
	open,
	initial,
	onClose,
	onConfirm,
}: Props) {
	const { t } = useTranslation();
	const [position, setPosition] = useState<Location>(
		() =>
			initial ?? {
				lat: DEFAULT_CENTER[0],
				lng: DEFAULT_CENTER[1],
			},
	);
	const [center, setCenter] = useState<[number, number]>([
		initial?.lat ?? DEFAULT_CENTER[0],
		initial?.lng ?? DEFAULT_CENTER[1],
	]);
	const [zoom, setZoom] = useState<number>(DEFAULT_ZOOM);
	const [busy, setBusy] = useState(false);
	const [errorKey, setErrorKey] = useState<string | null>(null);
	const markerRef = useRef<L.Marker | null>(null);

	useEffect(() => {
		if (!open) return;
		if (initial !== null) {
			setPosition({ lat: initial.lat, lng: initial.lng });
			setCenter([initial.lat, initial.lng]);
			setZoom(DEFAULT_ZOOM);
		}
		setErrorKey(null);
	}, [open, initial]);

	function handlePositionChange(loc: Location) {
		setPosition({ lat: loc.lat, lng: loc.lng });
		setCenter([loc.lat, loc.lng]);
	}

	function useDeviceLocation() {
		if (
			typeof navigator === "undefined" ||
			navigator.geolocation === undefined
		) {
			setErrorKey("error.geolocationDenied");
			return;
		}
		setBusy(true);
		navigator.geolocation.getCurrentPosition(
			(pos) => {
				const loc: Location = {
					lat: pos.coords.latitude,
					lng: pos.coords.longitude,
				};
				handlePositionChange(loc);
				setZoom(15);
				setBusy(false);
				setErrorKey(null);
			},
			() => {
				setBusy(false);
				setErrorKey("error.geolocationDenied");
			},
			{ enableHighAccuracy: true, timeout: 10_000 },
		);
	}

	function handleConfirm() {
		if (
			Number.isNaN(position.lat) ||
			Number.isNaN(position.lng) ||
			position.lat < -90 ||
			position.lat > 90 ||
			position.lng < -180 ||
			position.lng > 180
		) {
			setErrorKey("error.invalidCoords");
			return;
		}
		onConfirm({ lat: position.lat, lng: position.lng });
	}

	return (
		<Modal
			opened={open}
			onClose={onClose}
			title={
				<Group gap={6}>
					<MapPin size={18} />
					<span>{t("input.attachLocation")}</span>
				</Group>
			}
			size="lg"
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					{t("input.locationMapHint")}
				</Text>
				<div
					style={{
						height: 360,
						borderRadius: 8,
						overflow: "hidden",
					}}
				>
					<MapContainer
						key={`${initial?.lat ?? DEFAULT_CENTER[0]}-${initial?.lng ?? DEFAULT_CENTER[1]}`}
						center={center}
						zoom={zoom}
						style={{ height: "100%", width: "100%" }}
						scrollWheelZoom
					>
						<MapRecenter center={center} />
						<TileLayer
							attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
							url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
						/>
						<Marker
							draggable
							position={[position.lat, position.lng]}
							ref={markerRef}
							eventHandlers={{
								dragend: () => {
									const m = markerRef.current;
									if (m === null) return;
									const ll = m.getLatLng();
									handlePositionChange({ lat: ll.lat, lng: ll.lng });
								},
							}}
						/>
					</MapContainer>
				</div>
				<Group grow>
					<NumberInput
						label={t("input.locationCoords")}
						value={position.lat}
						onChange={(value) => {
							const n = typeof value === "number" ? value : Number(value);
							if (Number.isFinite(n)) {
								handlePositionChange({ lat: n, lng: position.lng });
							} else {
								setPosition((p) => ({ ...p, lat: Number.NaN }));
							}
						}}
						decimalScale={6}
						min={-90}
						max={90}
						step={0.0001}
					/>
					<NumberInput
						label="Lng"
						value={position.lng}
						onChange={(value) => {
							const n = typeof value === "number" ? value : Number(value);
							if (Number.isFinite(n)) {
								handlePositionChange({ lat: position.lat, lng: n });
							} else {
								setPosition((p) => ({ ...p, lng: Number.NaN }));
							}
						}}
						decimalScale={6}
						min={-180}
						max={180}
						step={0.0001}
					/>
				</Group>
				<Text size="xs" c="dimmed">
					📍 {formatCoords(position)}
				</Text>
				{errorKey !== null && (
					<Text size="sm" c="red" role="alert" aria-live="assertive">
						{t(errorKey)}
					</Text>
				)}
				<Group justify="space-between">
					<Button
						variant="subtle"
						color="gray"
						leftSection={busy ? <Loader size={14} /> : <Crosshair size={14} />}
						onClick={useDeviceLocation}
						disabled={busy}
					>
						{t("input.locationGetCurrent")}
					</Button>
					<Group gap="xs">
						<Button variant="subtle" color="gray" onClick={onClose}>
							{t("input.locationCancel")}
						</Button>
						<Button onClick={handleConfirm}>{t("input.locationSend")}</Button>
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}
