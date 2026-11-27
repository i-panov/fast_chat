import { useEffect, useState } from "react";
import { onLocalLockChanged } from "../e2ee/localLock.ts";

// A counter that changes whenever local key material changes (lock/unlock,
// creation, restore, rotation) so decryption hooks recompute messages that
// were cached as undecryptable before the keys were available.
export function useLocalLockRevision(): number {
	const [revision, setRevision] = useState(0);
	useEffect(() => onLocalLockChanged(() => setRevision((v) => v + 1)), []);
	return revision;
}
