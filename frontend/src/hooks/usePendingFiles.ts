import { useEffect, useRef, useState } from "react";
import type { PendingFile } from "../api.ts";

interface UsePendingFilesReturn {
	pendingFiles: PendingFile[];
	setPendingFiles: React.Dispatch<React.SetStateAction<PendingFile[]>>;
	handleAttachFiles: (files: File[]) => void;
	handleRemoveFile: (fileId: string) => void;
	handleClearAll: () => void;
}

function getFileType(mimeType: string): "photo" | "video" | "audio" | "file" {
	if (mimeType.startsWith("image/")) return "photo";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";
	return "file";
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
		for (const file of files) {
			const blobUrl = URL.createObjectURL(file);
			cleanupRef.current.add(blobUrl);

			setPendingFiles((prev) => [
				...prev,
				{
					id: crypto.randomUUID(),
					file,
					blobUrl,
					originalName: file.name,
					size: file.size,
					mimeType: file.type,
					fileType: getFileType(file.type),
				},
			]);
		}
	};

	const handleRemoveFile = (fileId: string) => {
		setPendingFiles((prev) => {
			const removed = prev.find((f) => f.id === fileId);
			if (removed) {
				try {
					URL.revokeObjectURL(removed.blobUrl);
					cleanupRef.current.delete(removed.blobUrl);
				} catch {
					/* ignore */
				}
			}
			return prev.filter((f) => f.id !== fileId);
		});
	};

	const handleClearAll = () => {
		setPendingFiles((prev) => {
			prev.forEach((f) => {
				try {
					URL.revokeObjectURL(f.blobUrl);
					cleanupRef.current.delete(f.blobUrl);
				} catch {
					/* ignore */
				}
			});
			return [];
		});
	};

	return {
		pendingFiles,
		setPendingFiles,
		handleAttachFiles,
		handleRemoveFile,
		handleClearAll,
	};
}
