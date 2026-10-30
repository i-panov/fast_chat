import { useEffect, useRef, useState } from "react";
import { subscribeToChanges } from "./notify.ts";

// Callers must memoize `query` with useCallback (or hoist it): an inline
// closure gets a new identity every render, and re-subscribing on every
// render hammers IDB and can loop. The latest closure is still always
// used via the ref, so memoization only affects *when* we re-run, never
// *what* runs.
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

	const queryRef = useRef(query);

	// Subscribe once: notifications always run the latest query via the ref.
	// The initial run is left to the [query] effect below so mount does not
	// read IDB twice.
	useEffect(() => {
		let alive = true;
		const run = () => {
			Promise.resolve(queryRef.current())
				.then((v) => {
					if (alive) setValue(v);
				})
				.catch(() => {});
		};
		const unsub = subscribeToChanges(run);
		return () => {
			alive = false;
			unsub();
		};
	}, []);

	// Re-run when the query identity changes (e.g. different arguments)
	// without tearing down the subscription. Must run in an effect, never
	// during render: callers pass inline closures with a fresh identity
	// every render, and setState during render would loop forever.
	// The ref sync lives here too (refs must not be written during render).
	useEffect(() => {
		queryRef.current = query;
		let alive = true;
		void Promise.resolve(query())
			.then((v) => {
				if (alive) setValue(v);
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [query]);

	return value;
}
