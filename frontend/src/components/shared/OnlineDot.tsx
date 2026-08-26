interface OnlineDotProps {
	online: boolean;
	label?: string;
}

export function OnlineDot({ online, label }: OnlineDotProps) {
	return (
		<output
			aria-label={label ?? (online ? "online" : "offline")}
			style={{
				display: "inline-block",
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
