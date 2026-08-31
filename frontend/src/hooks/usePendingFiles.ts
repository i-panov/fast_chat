import { useCallback, useEffect, useRef, useState } from "react";
import type { PendingFile } from "../types/api.ts";
import { getFileType } from "../utils/files.ts";

interface UsePendingFilesReturn {
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (fileId: string) => void;
	clearAllPendingFiles: () => void;
}

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

export function usePendingFiles(): UsePendingFilesReturn {
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

	const handleAttachFiles = useCallback((files: File[]) => {
		const newEntries: PendingFile[] = files.map((file) => {
			const blobUrl = URL.createObjectURL(file);
			cleanupRef.current.add(blobUrl);
			return {
				id: crypto.randomUUID(),
				file,
				blobUrl,
				originalName: file.name,
				size: file.size,
				mimeType: file.type,
				fileType: getFileType(file.type),
			};
		});
		setPendingFiles((prev) => [...prev, ...newEntries]);
	}, []);

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
