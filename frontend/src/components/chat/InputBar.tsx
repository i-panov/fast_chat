import { Button, Textarea } from "@mantine/core";
import type React from "react";

interface Props {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
}

export function InputBar({ text, onTextChange, onSubmit }: Props) {
	return (
		<form
			style={{
				display: "flex",
				gap: "8px",
				padding: "12px",
				borderTop: "1px solid var(--mantine-color-dark-4)",
				background: "var(--mantine-color-dark-8)",
			}}
			onSubmit={onSubmit}
		>
			<Textarea
				placeholder="Type a message..."
				value={text}
				onChange={(e) => onTextChange(e.target.value)}
				style={{ flex: 1 }}
				size="sm"
				autosize
				minRows={1}
				maxRows={6}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						e.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<Button type="submit" disabled={text.trim().length === 0} size="sm">
				Send
			</Button>
		</form>
	);
}
