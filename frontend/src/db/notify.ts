// Notification bus: any repo mutation calls notify() to wake up
// useLiveQuery subscribers across React components. We intentionally
// avoid the idb/liveQuery addon to keep the dependency surface small.
const bus = new EventTarget();

export function notify() {
	bus.dispatchEvent(new Event("change"));
}

export function subscribeToChanges(cb: () => void): () => void {
	const handler = () => cb();
	bus.addEventListener("change", handler);
	return () => bus.removeEventListener("change", handler);
}
