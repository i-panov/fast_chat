import { useEffect, useState } from "react";
import { KEY_MATERIAL_CHANNEL, KEY_TAB_ID } from "../e2ee/keys.ts";
import { onLocalLockChanged } from "../e2ee/localLock.ts";

// A counter that changes whenever local key material changes (lock/unlock,
// creation, restore, rotation) so decryption hooks recompute messages that
// were cached as undecryptable before the keys were available. Other tabs'
// rotations arrive over the key-material BroadcastChannel; without this bump
// an open drawer would keep decrypting with a stale key until a reload.
export function useLocalLockRevision(scope?: string): number {
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		let disposed = false;
		const bump = () => {
			if (!disposed) setRevision((value) => value + 1);
		};
		const off = onLocalLockChanged(bump);
		let channel: BroadcastChannel | null = null;
		if (typeof BroadcastChannel !== "undefined") {
			channel = new BroadcastChannel(KEY_MATERIAL_CHANNEL);
			channel.onmessage = (event: MessageEvent<unknown>) => {
				const data = event.data as { scope?: string; tabId?: string } | null;
				if (typeof data?.scope !== "string") return;
				if (data.tabId === KEY_TAB_ID) return;
				if (scope !== undefined && scope !== "" && data.scope !== scope) {
					return;
				}
				bump();
			};
		}
		return () => {
			disposed = true;
			off();
			channel?.close();
		};
	}, [scope]);

	return revision;
}
