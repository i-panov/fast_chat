import type { FileKey } from "../e2ee/file-crypto.ts";
import type { FileInfo } from "../types/api.ts";
import { fetchFileBlob } from "./downloadFile.ts";

// ClipboardItem accepts PNG in every browser that implements the async
// clipboard; WebP/JPEG/BMP from the server is converted first.
async function toPng(blob: Blob): Promise<Blob> {
	if (blob.type === "image/png") return blob;

	const bitmap = await createImageBitmap(blob);
	const canvas = document.createElement("canvas");
	canvas.width = bitmap.width;
	canvas.height = bitmap.height;

	const context = canvas.getContext("2d");
	if (context === null) {
		bitmap.close();
		throw new Error("canvas context is unavailable");
	}
	context.drawImage(bitmap, 0, 0);
	bitmap.close();

	return new Promise((resolve, reject) => {
		canvas.toBlob((png) => {
			if (png === null) {
				reject(new Error("could not encode the image"));
				return;
			}
			resolve(png);
		}, "image/png");
	});
}

export async function copyImageToClipboard(
	file: FileInfo,
	fileKey: FileKey | undefined,
	token: string | undefined,
): Promise<void> {
	if (
		navigator.clipboard?.write === undefined ||
		typeof ClipboardItem === "undefined"
	) {
		throw new Error("clipboard images are not supported");
	}

	// The item is constructed synchronously inside the user gesture: WebKit
	// drops the activation after the first await and expects a promise value
	// for the asynchronously produced PNG.
	const png = fetchFileBlob(file.url, token, fileKey, file.mimeType).then(
		toPng,
	);
	await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
