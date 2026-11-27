import { useEffect, useState } from "react";
import { hasLocalLock, isLocalLockUnlocked } from "../e2ee/keys.ts";
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
		const refresh = () => {
			void hasLocalLock(scope)
				.then((enabled) => {
					if (cancelled) return;
					setState({
						enabled,
						locked: enabled && !isLocalLockUnlocked(scope),
					});
				})
				.catch(() => {});
		};
		refresh();
		const off = onLocalLockChanged(refresh);
		return () => {
			cancelled = true;
			off();
		};
	}, [scope]);

	return state;
}
