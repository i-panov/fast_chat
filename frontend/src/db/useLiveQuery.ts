import { useEffect, useState } from "react";
import { subscribeToChanges } from "./notify.ts";

export function useLiveQuery<T>(query: () => T | Promise<T>): T {
	const [value, setValue] = useState<T>(() => {
		const result = query();
		// Queries that hit IDB are always async; the initial value is
		// only meaningful for synchronous factories. We type-erase to
		// avoid an awkward `T | undefined` return — callers should not
		// rely on the first render's contents anyway, since they
		// re-render as soon as the promise resolves.
		if (result instanceof Promise) {
			return undefined as unknown as T;
		}
		return result;
	});

	useEffect(() => {
		let alive = true;
		const run = () => {
			Promise.resolve(query())
				.then((v) => {
					if (alive) setValue(v);
				})
				.catch(() => {});
		};
		run();
		const unsub = subscribeToChanges(run);
		return () => {
			alive = false;
			unsub();
		};
	}, [query]);

	return value;
}
