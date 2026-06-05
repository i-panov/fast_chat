import { useEffect, useRef, useState } from "react";
import type { PendingFile } from "../api.ts";

interface UsePendingFilesReturn {
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (fileId: string) => void;
	clearAllPendingFiles: () => void;
}

function getFileType(mimeType: string): "photo" | "video" | "audio" | "file" {
	if (mimeType.startsWith("image/")) return "photo";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "file";
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
		return () => {
			cleanupRef.current.forEach((url) => {
				try {
					URL.revokeObjectURL(url);
				} catch {
					/* ignore */
				}
			});
			cleanupRef.current.clear();
		};
	}, []);

	const handleAttachFiles = (files: File[]) => {
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
	};

	const handleRemoveFile = (fileId: string) => {
		setPendingFiles((prev) => {
			const removed = prev.find((f) => f.id === fileId);
			if (removed) {
				revokeIfTracked(cleanupRef, removed.blobUrl);
			}
			return prev.filter((f) => f.id !== fileId);
		});
	};

	const clearAllPendingFiles = () => {
		setPendingFiles((prev) => {
			prev.forEach((f) => {
				revokeIfTracked(cleanupRef, f.blobUrl);
			});
			return [];
		});
	};

	return {
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		clearAllPendingFiles,
	};
}
