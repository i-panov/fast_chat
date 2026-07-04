import { Loader, Text, UnstyledButton } from "@mantine/core";
import { Download } from "lucide-react";
import { useState } from "react";
import type { FileInfo } from "../../types/api.ts";
import { useAuth } from "../../useAuth.tsx";
import { BORDER_RADIUS_SM } from "../../utils/constants.ts";
import { downloadFile } from "../../utils/downloadFile.ts";
import { formatSize } from "../../utils/files.ts";

interface Props {
	file: FileInfo;
}

export function FileDownloadAttachment({ file }: Props) {
	const { activeAccount } = useAuth();
	const [downloading, setDownloading] = useState(false);

	return (
		<UnstyledButton
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 10px",
				background: "var(--mantine-color-dark-6)",
				borderRadius: BORDER_RADIUS_SM,
				width: "100%",
				cursor: "pointer",
			}}
			onClick={() => {
				setDownloading(true);
				downloadFile(file.url, file.originalName, activeAccount?.token).finally(
					() => setDownloading(false),
				);
			}}
		>
			{downloading ? <Loader size="sm" /> : <Download size={24} />}
			<div style={{ overflow: "hidden", minWidth: 0 }}>
				<Text size="sm" truncate="end">
					{file.originalName}
				</Text>
				<Text size="xs" c="dimmed">
					{formatSize(file.size)}
				</Text>
			</div>
		</UnstyledButton>
	);
}
