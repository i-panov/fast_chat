interface OnlineDotProps {
	online: boolean;
}

export function OnlineDot({ online }: OnlineDotProps) {
	return (
		<div
			style={{
				width: 8,
				height: 8,
				borderRadius: "50%",
				background: online
					? "var(--mantine-color-green-6)"
					: "var(--mantine-color-gray-6)",
				flexShrink: 0,
			}}
		/>
	);
}
