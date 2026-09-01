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
	const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
	const cleanupRef = useRef<Set<string>>(new Set());

	// Очистка всех blobUrl при размонтировании
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

			setPendingFiles((prev) => [...prev, ...newEntries]);
		},
		[onLargeFile],
	);

	const handleRemoveFile = useCallback((fileId: string) => {
		setPendingFiles((prev) => {
			const removed = prev.find((f) => f.id === fileId);
			if (removed) {
				revokeIfTracked(cleanupRef, removed.blobUrl);
			}
			return prev.filter((f) => f.id !== fileId);
		});
	}, []);

	const clearAllPendingFiles = useCallback(() => {
		setPendingFiles((prev) => {
			for (const f of prev) {
				revokeIfTracked(cleanupRef, f.blobUrl);
			}
			return [];
		});
	}, []);

	return {
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		clearAllPendingFiles,
	};
}
