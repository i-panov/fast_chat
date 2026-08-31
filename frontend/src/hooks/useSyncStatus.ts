import { useSyncExternalStore } from "react";
import {
	getSyncState,
	type SyncState,
	subscribeSyncState,
} from "../sync/syncEngine.ts";

export function useSyncStatus(): SyncState {
	return useSyncExternalStore(subscribeSyncState, getSyncState);
}
