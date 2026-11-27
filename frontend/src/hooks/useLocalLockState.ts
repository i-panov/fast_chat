import { useEffect, useState } from "react";
import {
	hasLocalLock,
	isLocalLockUnlocked,
	KEY_MATERIAL_CHANNEL,
	KEY_TAB_ID,
} from "../e2ee/keys.ts";
import { onLocalLockChanged } from "../e2ee/localLock.ts";

export interface LocalLockState {
	enabled: boolean;
	locked: boolean;
}

// useLocalLockState reports whether the account has a local unlock factor
// configured and whether its keys are currently available in this tab. The
// scope is passed explicitly so switching accounts re-reads the right DB.
export function useLocalLockState(scope: string): LocalLockState {
	const [state, setState] = useState<LocalLockState>({
		enabled: false,
		locked: false,
	});

	useEffect(() => {
		let cancelled = false;
		// Only the newest read may commit: a slow read for the previous scope
		// or an older revision must not overwrite fresher lock state.
		let requestId = 0;
		const refresh = () => {
			const current = ++requestId;
			void hasLocalLock(scope)
				.then((enabled) => {
					if (cancelled || current !== requestId) return;
					setState({
						enabled,
						locked: enabled && !isLocalLockUnlocked(scope),
					});
				})
				.catch(() => {});
		};
		refresh();
		const off = onLocalLockChanged(refresh);
		let channel: BroadcastChannel | null = null;
		if (typeof BroadcastChannel !== "undefined") {
			// Another tab may unlock, rotate or lock this account. The local
			// tab does not necessarily have a modal mounted that re-broadcasts
			// the event, so follow the channel directly.
			channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
			channel.onmessage = (event: MessageEvent<unknown>) => {
				const data = event.data as { scope?: string; tabId?: string } | null;
				if (typeof data?.scope !== "string" || data.scope !== scope) return;
				if (data.tabId === KEY_TAB_ID) return;
				refresh();
			};
		}
		return () => {
			cancelled = true;
			requestId += 1;
			off();
			channel?.close();
		};
	}, [scope]);

	return state;
}
