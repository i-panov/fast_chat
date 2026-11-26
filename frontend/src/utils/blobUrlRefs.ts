// Shared refcount for object URLs that outlive the component that created
// them. A voice bubble revokes its blob URL on unmount, but the global audio
// player may still be playing that same URL; the player retains it and the
// bytes disappear only when both owners release it.
const counts = new Map<string, number>();

// registerBlobUrl marks a URL this app has just created.
export function registerBlobUrl(url: string): void {
	if (!url.startsWith("blob:")) return;
	counts.set(url, 1);
}

// retainBlobUrl takes an extra reference to an already registered URL. It
// returns false for a foreign URL, which the caller must leave alone.
export function retainBlobUrl(url: string): boolean {
	if (!url.startsWith("blob:")) return false;
	const count = counts.get(url) ?? 0;
	if (count === 0) return false;
	counts.set(url, count + 1);
	return true;
}

export function releaseBlobUrl(url: string): void {
	if (!url.startsWith("blob:")) return;
	const count = counts.get(url) ?? 0;
	// A URL this module never retained belongs to someone else: revoking it
	// would kill a blob the player or another component still uses.
	if (count === 0) return;
	if (count === 1) {
		counts.delete(url);
		URL.revokeObjectURL(url);
		return;
	}
	counts.set(url, count - 1);
}
