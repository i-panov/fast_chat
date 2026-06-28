export async function downloadFile(
	fileUrl: string,
	filename: string,
	token?: string,
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
	const blobUrl = URL.createObjectURL(blob);

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
