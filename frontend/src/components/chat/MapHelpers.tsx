import { useEffect } from "react";
import { useMap, useMapEvents } from "react-leaflet";
import type { Location } from "../../types/api.ts";

export function MapAutoSize({ open }: { open: boolean }) {
	const map = useMap();
	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => map.invalidateSize(), 200);
		return () => clearTimeout(timer);
	}, [map, open]);
	return null;
}

export function MapClickHandler({
	onClick,
}: {
	onClick: (loc: Location) => void;
}) {
	useMapEvents({
		click: (e) => {
			onClick({ lat: e.latlng.lat, lng: e.latlng.lng });
		},
	});
	return null;
}
