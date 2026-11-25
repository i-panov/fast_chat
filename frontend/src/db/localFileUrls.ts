import type { FileInfo } from "../types/api.ts";

// A message that is still being sent keeps the local preview URLs of its
// attachments: the bubble shows the photo straight from the picked File
// instead of waiting for the upload. The URL belongs to the optimistic row
// and must be revoked when the server copy replaces it, otherwise the blob
// stays referenced for the rest of the session.
function isLocalPreview(url: string | undefined): url is string {
	return url?.startsWith("blob:") === true;
}

function revoke(urls: Iterable<string>): void {
	for (const url of urls) {
		try {
			URL.revokeObjectURL(url);
		} catch {
			// A URL from another realm or an already-revoked one: nothing to do.
		}
	}
}

// dropReplacedLocalFileUrls revokes the preview URLs of the previous row that
// the incoming row no longer references.
export function dropReplacedLocalFileUrls(
	previous: FileInfo[] | undefined,
	next: FileInfo[] | undefined,
): void {
	if (previous === undefined || previous.length === 0) return;

	const nextUrls = new Set((next ?? []).map((file) => file.url));
	const dropped = previous
		.filter((file) => isLocalPreview(file.url) && !nextUrls.has(file.url))
		.map((file) => file.url);
	revoke(dropped.filter((url): url is string => url !== undefined));
}

// releaseLocalFileUrls revokes every local preview URL of a row that is being
// deleted or tombstoned: nothing renders those attachments any more.
export function releaseLocalFileUrls(files: FileInfo[] | undefined): void {
	if (files === undefined || files.length === 0) return;

	revoke(
		files
			.map((file) => file.url)
			.filter((url): url is string => isLocalPreview(url)),
	);
}
