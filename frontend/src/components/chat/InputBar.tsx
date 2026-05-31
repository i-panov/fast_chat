import { ActionIcon, Button, Paper, Text, Textarea } from "@mantine/core";
import { X } from "lucide-react";
import type React from "react";

interface Props {
	text: string;
	onTextChange: (value: string) => void;
	onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
	editing: boolean;
	onCancelEdit: () => void;
}

export function InputBar({
	text,
	onTextChange,
	onSubmit,
	editing,
	onCancelEdit,
}: Props) {
	return (
		<div>
			{editing && (
				<Paper
					style={{
						padding: "8px 12px",
						borderRadius: 0,
						borderTop: "1px solid var(--mantine-color-dark-4)",
						background: "var(--mantine-color-dark-7)",
						display: "flex",
						alignItems: "center",
						justifyContent: "space-between",
					}}
				>
					<Text size="sm" c="blue">
						Редактирование
					</Text>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						onClick={onCancelEdit}
					>
						<X size={16} />
					</ActionIcon>
				</Paper>
			)}
			<form
				style={{
					display: "flex",
					gap: "8px",
					padding: "12px",
					borderTop: editing
						? undefined
						: "1px solid var(--mantine-color-dark-4)",
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
						if (e.key === "Escape" && editing) {
							onCancelEdit();
						}
					}}
				/>
				<Button type="submit" disabled={text.trim().length === 0} size="sm">
					{editing ? "Save" : "Send"}
				</Button>
			</form>
		</div>
	);
}
