import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingFile } from "../types/api.ts";
import { LargeFileThreshold } from "../types/api.ts";
import { getFileType } from "../utils/files.ts";

interface UsePendingFilesReturn {
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => Promise<void>;
	handleRemoveFile: (fileId: string) => void;
	clearAllPendingFiles: () => void;
}

// onLargeFile is invoked when a file exceeds LargeFileThreshold. The callback
// receives the file and a resolve function: call resolve(true) to encrypt,
// resolve(false) to send unencrypted. The hook awaits the callback before
// adding the file so the UI can show a confirmation dialog.
export type LargeFileHandler = (
	file: File,
	resolve: (encrypt: boolean) => void,
) => Promise<void> | void;

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

	const clearAllPendingFiles = useCallback(() => {
		for (const f of filesRef.current) {
			revokeIfTracked(cleanupRef, f.blobUrl);
		}
		setPendingFilesState([]);
	}, []);

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
	};
}
