import type { FileKey } from "../e2ee/file-crypto.ts";
import { decryptFileStream } from "../e2ee/file-crypto.ts";

export async function downloadFile(
	fileUrl: string,
	filename: string,
	token?: string,
	fileKey?: FileKey,
): Promise<void> {
	const headers: Record<string, string> = {};
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	const resp = await fetch(fileUrl, { headers });
	if (!resp.ok) {
		throw new Error(`Failed to download file: ${resp.status}`);
	}

	const blob = await resp.blob();

	// Decrypt if a key is provided (encrypted file).
	const finalBlob = fileKey ? await decryptBlob(blob, fileKey) : blob;

	const blobUrl = URL.createObjectURL(finalBlob);

	try {
		const a = document.createElement("a");
		a.href = blobUrl;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	} finally {
		URL.revokeObjectURL(blobUrl);
	}
}

async function decryptBlob(blob: Blob, fileKey: FileKey): Promise<Blob> {
	const ciphertext = new Uint8Array(await blob.arrayBuffer());
	const plain = await decryptFileStream(ciphertext, fileKey);

	return new Blob([plain as unknown as ArrayBuffer]);
}
