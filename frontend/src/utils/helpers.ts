export function stripMeta<T extends { _updatedAt: string }>(
	obj: T,
): Omit<T, "_updatedAt"> {
	const { _updatedAt: _, ...rest } = obj;
	return rest;
}
