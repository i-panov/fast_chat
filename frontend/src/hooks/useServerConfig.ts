import { useEffect, useRef, useState } from "react";
import { getConfig } from "../api.ts";

interface ServerConfig {
	messageEditTTL: number;
	messageDeleteTTL: number;
}

export function useServerConfig(token: string | null | undefined): {
	config: ServerConfig | null;
} {
	const [config, setConfig] = useState<ServerConfig | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	// getConfig is a public endpoint: the token only gates whether the page
	// needs the config, it is never sent with the request. Fetch once per
	// session; the AbortController flag guards the late response because the
	// API layer takes no signal.
	const fetchedRef = useRef(false);

	useEffect(() => {
		if (!token) return;
		if (fetchedRef.current) return;
		fetchedRef.current = true;
		abortRef.current?.abort();
		const ctrl = new AbortController();
		abortRef.current = ctrl;
		getConfig()
			.then((cfg) => {
				if (!ctrl.signal.aborted) setConfig(cfg);
			})
			.catch(() => {
				fetchedRef.current = false;
			});
		return () => ctrl.abort();
	}, [token]);

	return { config: token ? config : null };
}
