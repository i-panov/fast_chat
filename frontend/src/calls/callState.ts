import { useSyncExternalStore } from "react";
import type { CallManager } from "./callManager.ts";
import type { CallView } from "./callTypes.ts";

type Listener = () => void;

// CallStore keeps the state of the call and notifies the subscribers when it
// changes. The manager stays the owner of the connection; the store only
// mirrors what the interface needs.
export function createCallStore(manager: CallManager) {
	const listeners = new Set<Listener>();
	let snapshot: CallView = manager.state();

	const unsubscribe = manager.subscribe(() => {
		snapshot = manager.state();

		for (const listener of listeners) {
			listener();
		}
	});

	return {
		subscribe(listener: Listener) {
			listeners.add(listener);

			return () => {
				listeners.delete(listener);
			};
		},
		getSnapshot() {
			return snapshot;
		},
		dispose() {
			unsubscribe();
			listeners.clear();
		},
	};
}

// useCallState subscribes a component to the state of the call.
export function useCallState(
	store: ReturnType<typeof createCallStore>,
): CallView {
	return useSyncExternalStore(
		(listener) => store.subscribe(listener),
		() => store.getSnapshot(),
		() => store.getSnapshot(),
	);
}
