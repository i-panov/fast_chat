// Compares two ISO timestamps numerically (by parsed epoch ms) so that
// mixed timestamp formats sort correctly instead of lexicographically.
// The server (Go) emits RFC3339Nano with trailing zeros trimmed
// ("...09.5Z"), while the browser's optimistic inserts use
// toISOString() ("...09.500Z"). String comparison mis-orders messages
// that share the same second; numeric comparison does not.
export function compareByCreatedAt(
	a: string,
	b: string,
	idA: string,
	idB: string,
): number {
	const ta = Date.parse(a);
	const tb = Date.parse(b);

	if (Number.isNaN(ta) || Number.isNaN(tb)) {
		return a.localeCompare(b) || idA.localeCompare(idB);
	}

	if (ta !== tb) {
		return ta - tb;
	}

	return idA.localeCompare(idB);
}
