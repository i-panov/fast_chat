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

	useEffect(() => {
		if (!token) {
			setConfig(null);
			return;
		}
		abortRef.current?.abort();
		const ctrl = new AbortController();
		abortRef.current = ctrl;
		getConfig()
			.then((cfg) => {
				if (!ctrl.signal.aborted) setConfig(cfg);
			})
			.catch(() => {});
		return () => ctrl.abort();
	}, [token]);

	return { config };
}
