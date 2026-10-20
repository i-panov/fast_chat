import type { FileInfo } from "../types/api.ts";

// fileTypeForMime classifies a file the way the server does (see
// File.ToFileInfo in backend/model/types.go), so a client that knows the real
// type of a file shows the same attachment kind as the server.
//
// The two rules cannot share code across the languages, so they have to stay
// in sync: a new kind on the server belongs here as well.
export function fileTypeForMime(mimeType: string): FileInfo["fileType"] {
	if (mimeType.startsWith("image/")) return "photo";
	if (mimeType.startsWith("video/")) return "video";
	if (mimeType.startsWith("audio/")) return "audio";

	return "file";
}
