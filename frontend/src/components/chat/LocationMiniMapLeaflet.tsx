import { MapContainer, Marker, TileLayer } from "react-leaflet";
import type { Location } from "../../api.ts";
import "../../utils/leafletIconFix.ts";

interface Props {
	location: Location;
	onReady?: () => void;
}

export function LocationMiniMapLeaflet({ location, onReady }: Props) {
	return (
		<MapContainer
			center={[location.lat, location.lng]}
			zoom={14}
			style={{ height: "100%", width: "100%" }}
			dragging={false}
			scrollWheelZoom={false}
			doubleClickZoom={false}
			zoomControl={false}
			attributionControl={false}
			className="leaflet-dark"
			ref={() => {
				onReady?.();
			}}
		>
			<TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
			<Marker position={[location.lat, location.lng]} interactive={false} />
		</MapContainer>
	);
}
