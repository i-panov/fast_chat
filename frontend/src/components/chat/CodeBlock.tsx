import { ActionIcon, Text } from "@mantine/core";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { BORDER_RADIUS_XS } from "../../utils/constants.ts";

const CODE_BLOCK_MAX_HEIGHT = 300;

interface Props {
	className?: string;
	code: string;
	lang: string;
}

export function CodeBlock({ className, code, lang }: Props) {
	const [copied, setCopied] = useState(false);

	return (
		<div
			style={{
				maxHeight: CODE_BLOCK_MAX_HEIGHT,
				overflow: "auto",
				background: "var(--mantine-color-dark-7)",
				borderRadius: BORDER_RADIUS_XS,
				marginTop: "4px",
				marginBottom: "2px",
			}}
		>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					position: "sticky",
					top: 0,
					background: "var(--mantine-color-dark-6)",
					padding: "2px 8px",
					borderBottom: "1px solid var(--mantine-color-dark-4)",
					zIndex: 1,
				}}
			>
				{lang ? (
					<Text size="xs" c="gray.6">
						{lang}
					</Text>
				) : (
					<div />
				)}
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={() => {
						void navigator.clipboard.writeText(code).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						});
					}}
				>
					{copied ? <Check size={14} /> : <Copy size={14} />}
				</ActionIcon>
			</div>
			<pre style={{ padding: "8px", margin: 0 }}>
				<code className={className}>{code}</code>
			</pre>
		</div>
	);
}
