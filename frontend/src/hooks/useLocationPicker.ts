import { useCallback, useState } from "react";
import type { Location } from "../api.ts";

export interface UseLocationPickerReturn {
	pendingLocation: Location | null;
	locationPickerOpen: boolean;
	setLocationPickerOpen: (v: boolean) => void;
	openLocationPicker: () => void;
	handleLocationConfirm: (loc: Location) => void;
	handleRemovePendingLocation: () => void;
	clearPendingLocation: () => void;
}

export function useLocationPicker(): UseLocationPickerReturn {
	const [pendingLocation, setPendingLocation] = useState<Location | null>(null);
	const [locationPickerOpen, setLocationPickerOpen] = useState(false);

	const openLocationPicker = useCallback(() => {
		setLocationPickerOpen(true);
	}, []);

	const handleLocationConfirm = useCallback((loc: Location) => {
		setPendingLocation(loc);
		setLocationPickerOpen(false);
	}, []);

	const handleRemovePendingLocation = useCallback(() => {
		setPendingLocation(null);
	}, []);

	const clearPendingLocation = useCallback(() => {
		setPendingLocation(null);
	}, []);

	return {
		pendingLocation,
		locationPickerOpen,
		setLocationPickerOpen,
		openLocationPicker,
		handleLocationConfirm,
		handleRemovePendingLocation,
		clearPendingLocation,
	};
}
