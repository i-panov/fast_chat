import { useEffect, useState } from "react";
import { getConfig } from "../api.ts";

interface ServerConfig {
	messageEditTTL: number;
	messageDeleteTTL: number;
}

export function useServerConfig(token: string | null | undefined): {
	config: ServerConfig | null;
} {
	const [config, setConfig] = useState<ServerConfig | null>(null);

	// getConfig is a public endpoint: the token only gates whether the page
	// needs the config, it is never sent with the request. There is
	// deliberately no "already fetched" ref: StrictMode mounts the effect
	// twice and a ref set before the response would make the second mount
	// skip the request, leaving config null forever (TTL 0, no editing).
	// Each run is identified by its own AbortController: a token change or an
	// unmount cancels the request, and the next run fetches again.
	useEffect(() => {
		if (!token) return;
		const ctrl = new AbortController();
		getConfig(ctrl.signal)
			.then((cfg) => {
				if (!ctrl.signal.aborted) setConfig(cfg);
			})
			.catch(() => {
				// The hook falls back to a null config; the next token change
				// retries.
			});
		return () => ctrl.abort();
	}, [token]);

	return { config: token ? config : null };
}
