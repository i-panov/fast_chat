import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingFile } from "../types/api.ts";
import { LargeFileThreshold } from "../types/api.ts";
import { getFileType } from "../utils/files.ts";

interface UsePendingFilesReturn {
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => Promise<void>;
	handleRemoveFile: (fileId: string) => void;
	clearAllPendingFiles: (keepObjectUrls?: boolean) => void;
	// removePendingFiles drops specific attachments (the ones a submit took a
	// snapshot of) so files attached while the send was in flight survive.
	removePendingFiles: (fileIds: string[], keepObjectUrls?: boolean) => void;
}

// onLargeFile is invoked when a file exceeds LargeFileThreshold. The callback
// receives the file and a resolve function: call resolve(true) to encrypt,
// resolve(false) to send unencrypted. The hook awaits the callback before
// adding the file so the UI can show a confirmation dialog.
export type LargeFileHandler = (
	file: File,
	resolve: (encrypt: boolean) => void,
) => Promise<void> | void;

const MAX_PENDING_FILES = 10;

function revokeIfTracked(
	cleanupRef: React.MutableRefObject<Set<string>>,
	blobUrl: string,
) {
	try {
		URL.revokeObjectURL(blobUrl);
		cleanupRef.current.delete(blobUrl);
	} catch {
		/* ignore */
	}
}

export function usePendingFiles(
	onLargeFile?: LargeFileHandler,
): UsePendingFilesReturn {
	const [pendingFiles, setPendingFilesState] = useState<PendingFile[]>([]);
	const cleanupRef = useRef<Set<string>>(new Set());
	// Read-only snapshot of the list for computing revokes outside of
	// setState updaters (updaters must stay pure: concurrent mode may
	// invoke them twice or discard the result, which would revoke live
	// URLs or corrupt cleanupRef).
	const filesRef = useRef(pendingFiles);
	useEffect(() => {
		filesRef.current = pendingFiles;
	}, [pendingFiles]);

	// Revoke blobUrls on unmount
	useEffect(() => {
		const urls = cleanupRef.current;

		return () => {
			for (const url of urls) {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* ignore */
				}
			}
			urls.clear();
		};
	}, []);

	const handleAttachFiles = useCallback(
		async (files: File[]) => {
			const newEntries: PendingFile[] = [];

			for (const file of files) {
				// The server accepts at most 10 attachments per message. Failing
				// at attach time beats encrypting and uploading 11+ files only to
				// get a terminal 400 with orphaned blobs.
				if (filesRef.current.length + newEntries.length >= MAX_PENDING_FILES) {
					break;
				}
				const exceedsThreshold = file.size > LargeFileThreshold;
				let encrypt = true;

				if (exceedsThreshold && onLargeFile !== undefined) {
					// Await the user's choice before adding the file.
					encrypt = await new Promise<boolean>((resolve) => {
						void onLargeFile(file, resolve);
					});
				}

				const blobUrl = URL.createObjectURL(file);
				cleanupRef.current.add(blobUrl);
				newEntries.push({
					id: crypto.randomUUID(),
					file,
					blobUrl,
					originalName: file.name,
					size: file.size,
					mimeType: file.type,
					fileType: getFileType(file.type),
					encrypted: encrypt,
				});
			}

			setPendingFilesState((prev) => [...prev, ...newEntries]);
		},
		[onLargeFile],
	);

	const handleRemoveFile = useCallback((fileId: string) => {
		const removed = filesRef.current.find((f) => f.id === fileId);
		if (removed) {
			revokeIfTracked(cleanupRef, removed.blobUrl);
		}
		setPendingFilesState((prev) => prev.filter((f) => f.id !== fileId));
	}, []);

	// clearAllPendingFiles drops the staged attachments. After a successful
	// send the object URLs must stay alive: the optimistic message row
	// renders the photo from them until the server copy replaces the row,
	// which is also where they are released.
	const clearAllPendingFiles = useCallback((keepObjectUrls = false) => {
		for (const f of filesRef.current) {
			if (keepObjectUrls) {
				// Ownership moves to the message row that now references the
				// URL; the repos release it when they replace or delete the
				// row. Keeping it in cleanupRef would make an unmount revoke a
				// URL that a queued bubble still renders.
				cleanupRef.current.delete(f.blobUrl);
			} else {
				revokeIfTracked(cleanupRef, f.blobUrl);
			}
		}
		setPendingFilesState([]);
	}, []);

	// removePendingFiles drops specific attachments (the ones a submit took a
	// snapshot of) so files attached while the send was in flight survive.
	const removePendingFiles = useCallback(
		(fileIds: string[], keepObjectUrls = false) => {
			const ids = new Set(fileIds);
			for (const f of filesRef.current) {
				if (!ids.has(f.id)) continue;
				if (keepObjectUrls) {
					cleanupRef.current.delete(f.blobUrl);
				} else {
					revokeIfTracked(cleanupRef, f.blobUrl);
				}
			}
			setPendingFilesState((prev) => prev.filter((f) => !ids.has(f.id)));
		},
		[],
	);

	// Tracked setter: keeps cleanupRef in sync so direct state updates cannot
	// leak blob URLs (missing revoke) or double-revoke URLs created elsewhere.
	// The diff is computed from the snapshot before setState, never inside
	// the updater.
	const setPendingFiles = useCallback<
		React.Dispatch<React.SetStateAction<PendingFile[]>>
	>((action) => {
		const prev = filesRef.current;
		const next = typeof action === "function" ? action(prev) : action;
		const prevUrls = new Set(prev.map((f) => f.blobUrl));
		const nextUrls = new Set(next.map((f) => f.blobUrl));
		for (const f of prev) {
			if (!nextUrls.has(f.blobUrl)) {
				revokeIfTracked(cleanupRef, f.blobUrl);
			}
		}
		for (const url of nextUrls) {
			if (!prevUrls.has(url)) {
				cleanupRef.current.add(url);
			}
		}
		setPendingFilesState(next);
	}, []);

	return {
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		clearAllPendingFiles,
		removePendingFiles,
	};
}
