import { useEffect, useState } from "react";
import {
	getSyncState,
	type SyncState,
	subscribeSyncState,
} from "../sync/syncEngine.ts";

export function useSyncStatus(): SyncState {
	const [state, setState] = useState<SyncState>(() => getSyncState());
	useEffect(() => {
		setState(getSyncState());
		return subscribeSyncState(setState);
	}, []);
	return state;
}
